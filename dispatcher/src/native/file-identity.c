#ifdef __linux__
#define _GNU_SOURCE
#endif
#include "sqlite3ext.h"
#include <string.h>
#include <stdio.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/stat.h>
#include <unistd.h>
SQLITE_EXTENSION_INIT1

typedef struct {
  sqlite3 *database; int references; int active; int clock_read_only;
  unsigned char token[32]; char clock_transaction[129];
} mutation_guard;

static void release_guard(void *value) {
  mutation_guard *guard = value;
  if (--guard->references == 0) { memset(guard, 0, sizeof(*guard)); sqlite3_free(guard); }
}

/* A read-only predicate for exact, schema-verified BEFORE INSERT triggers.
 * Bare schema fixtures may insert outside a security transaction; an active
 * audited mutation must bind every new ledger row to its current reservation. */
static void clock_reference(sqlite3_context *context, int argc, sqlite3_value **argv) {
  mutation_guard *guard = sqlite3_user_data(context);
  (void)argc;
  if (!guard->active) { sqlite3_result_int(context, 1); return; }
  if (!guard->clock_read_only || sqlite3_value_type(argv[0]) != SQLITE_TEXT) {
    sqlite3_result_int(context, 0); return;
  }
  const char *value = (const char *)sqlite3_value_text(argv[0]);
  int length = sqlite3_value_bytes(argv[0]);
  sqlite3_result_int(context, value && length > 0 && length <= 128 &&
    (size_t)length == strlen(guard->clock_transaction) &&
    !memcmp(value, guard->clock_transaction, (size_t)length));
}

static int authorize_mutation(void *data, int action, const char *first,
  const char *second, const char *database, const char *source) {
  mutation_guard *guard = data;
  (void)source;
  switch (action) {
    case SQLITE_READ: case SQLITE_SELECT: case SQLITE_RECURSIVE: return SQLITE_OK;
    case SQLITE_INSERT: case SQLITE_UPDATE: case SQLITE_DELETE:
      if (!database || strcmp(database, "main") || !first ||
        !strncmp(first, "sqlite_", 7) || !strncmp(first, "security_audit_", 15)) return SQLITE_DENY;
      if (guard->clock_read_only && !sqlite3_stricmp(first, "approval_clock_reservations")) return SQLITE_DENY;
      return SQLITE_OK;
    case SQLITE_FUNCTION:
      return second && sqlite3_stricmp(second, "load_extension") && sqlite3_stricmp(second, "dona_publish_mutex") ? SQLITE_OK : SQLITE_DENY;
    case SQLITE_PRAGMA:
      /* Only the fixed read-only checks used by the repository are permitted. */
      return !second && first && (!strcmp(first, "foreign_keys") ||
        !strcmp(first, "recursive_triggers") || !strcmp(first, "foreign_key_check") ||
        !strcmp(first, "ignore_check_constraints") || !strcmp(first, "encoding") ||
        !strcmp(first, "application_id") || !strcmp(first, "query_only")) ? SQLITE_OK : SQLITE_DENY;
    default: return SQLITE_DENY;
  }
}

/* Publish a CLOSED private staging file without a hardlink interval and without
 * replacing an existing inode. Never fall back to ordinary replacing rename. */
static void publish_mutex(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc;
  if (sqlite3_value_type(argv[0]) != SQLITE_TEXT || sqlite3_value_type(argv[1]) != SQLITE_TEXT) goto failed;
  const char *source = (const char *)sqlite3_value_text(argv[0]);
  const char *target = (const char *)sqlite3_value_text(argv[1]);
  if (!source || !target || strlen(source) != (size_t)sqlite3_value_bytes(argv[0]) ||
      strlen(target) != (size_t)sqlite3_value_bytes(argv[1])) goto failed;
  int status;
#ifdef __APPLE__
  status = renamex_np(source, target, RENAME_EXCL);
#elif defined(__linux__)
  status = renameat2(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE);
#else
  goto failed;
#endif
  if (status == 0) { sqlite3_result_int(context, 1); return; }
  if (errno == EEXIST) { sqlite3_result_int(context, 0); return; }
failed:
  sqlite3_result_error(context, "security_mutex_publish_failed", -1);
}

static void control_mutation(sqlite3_context *context, int argc, sqlite3_value **argv) {
  mutation_guard *guard = sqlite3_user_data(context);
  if (argc < 2 || argc > 3 || sqlite3_value_type(argv[0]) != SQLITE_BLOB || sqlite3_value_bytes(argv[0]) != 32 ||
      sqlite3_value_type(argv[1]) != SQLITE_INTEGER) goto rejected;
  sqlite3_int64 enabled = sqlite3_value_int64(argv[1]);
  const unsigned char *token = sqlite3_value_blob(argv[0]);
  if (!token) goto rejected;
  if (enabled == 1 && !guard->active && !sqlite3_get_autocommit(guard->database)) {
    memcpy(guard->token, token, 32);
    if (sqlite3_set_authorizer(guard->database, authorize_mutation, guard) != SQLITE_OK) goto rejected;
    guard->active = 1;
  } else if ((enabled == 0 || enabled == 2 || enabled == 3) && guard->active) {
    unsigned int difference = 0;
    for (int i = 0; i < 32; i++) difference |= guard->token[i] ^ token[i];
    if (difference) goto rejected;
    if (enabled == 0) {
      if (sqlite3_set_authorizer(guard->database, 0, 0) != SQLITE_OK) goto rejected;
      guard->active = 0;
      guard->clock_read_only = 0;
      memset(guard->clock_transaction, 0, sizeof(guard->clock_transaction));
      memset(guard->token, 0, 32);
    } else {
      if ((enabled == 2 && guard->clock_read_only) || (enabled == 3 && !guard->clock_read_only)) goto rejected;
      if (enabled == 2) {
        if (argc != 3 || sqlite3_value_type(argv[2]) != SQLITE_TEXT) goto rejected;
        const unsigned char *value = sqlite3_value_text(argv[2]);
        int length = sqlite3_value_bytes(argv[2]);
        if (!value || length < 1 || length > 128) goto rejected;
        for (int i = 0; i < length; i++) {
          unsigned char c = value[i];
          if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '_' || c == '-')) goto rejected;
        }
        memcpy(guard->clock_transaction, value, (size_t)length);
        guard->clock_transaction[length] = 0;
      }
      /* Reinstalling expires statements prepared before the stricter phase. */
      if (sqlite3_set_authorizer(guard->database, authorize_mutation, guard) != SQLITE_OK) goto rejected;
      guard->clock_read_only = enabled == 2;
      if (enabled == 3) memset(guard->clock_transaction, 0, sizeof(guard->clock_transaction));
    }
  } else goto rejected;
  sqlite3_result_int(context, 1);
  return;
rejected:
  sqlite3_result_error(context, "security_sql_guard_unverified", -1);
}

/* Ask SQLite's own open file, not a second pathname lookup. No extra file
 * descriptor is opened or closed on a database that may hold POSIX locks. */
static void file_identity_ok(sqlite3_context *context, int argc, sqlite3_value **argv) {
  int moved = -1;
  (void)argc;
  (void)argv;
  int status = sqlite3_file_control(sqlite3_context_db_handle(context), "main", SQLITE_FCNTL_HAS_MOVED, &moved);
  if (status != SQLITE_OK || (moved != 0 && moved != 1)) {
    sqlite3_result_error(context, "security_file_identity_unavailable", -1);
    return;
  }
  sqlite3_result_int(context, moved == 0);
}

/* Copy one validated metadata row at a time. No source secret value, free page,
 * or full database image is loaded into memory or written to the destination.
 * Pager caches and per-value size are bounded independently of source DB size. */
static int copy_metadata_table(sqlite3 *source, sqlite3 *output, const char *name) {
  sqlite3_stmt *read = NULL, *write = NULL; char *query = NULL; sqlite3_str *builder = NULL;
  int ok = 0, status, columns;
  query = sqlite3_mprintf("SELECT * FROM main.\"%w\"", name);
  if (!query || sqlite3_prepare_v2(source, query, -1, &read, NULL) != SQLITE_OK) goto cleanup;
  sqlite3_free(query); query = NULL; columns = sqlite3_column_count(read);
  if (columns < 1 || columns > 64) goto cleanup;
  builder = sqlite3_str_new(output); if (!builder) goto cleanup;
  sqlite3_str_appendf(builder, "INSERT INTO main.\"%w\" VALUES(", name);
  for (int index = 0; index < columns; index++) sqlite3_str_appendall(builder, index == 0 ? "?" : ",?");
  sqlite3_str_appendall(builder, ")"); query = sqlite3_str_finish(builder); builder = NULL;
  if (!query || sqlite3_prepare_v2(output, query, -1, &write, NULL) != SQLITE_OK) goto cleanup;
  while ((status = sqlite3_step(read)) == SQLITE_ROW) {
    for (int index = 0; index < columns; index++) {
      if (sqlite3_column_bytes(read, index) > 2 * 1024 * 1024
        || sqlite3_bind_value(write, index + 1, sqlite3_column_value(read, index)) != SQLITE_OK) goto cleanup;
    }
    if (sqlite3_step(write) != SQLITE_DONE || sqlite3_reset(write) != SQLITE_OK
      || sqlite3_clear_bindings(write) != SQLITE_OK) goto cleanup;
  }
  ok = status == SQLITE_DONE;
cleanup:
  if (read) sqlite3_finalize(read);
  if (write) sqlite3_finalize(write);
  if (builder) sqlite3_free(sqlite3_str_finish(builder));
  sqlite3_free(query);
  return ok ? SQLITE_OK : SQLITE_ERROR;
}

static int copy_metadata_image(sqlite3 *destination, sqlite3 *projection) {
  sqlite3_backup *backup = sqlite3_backup_init(destination, "main", projection, "main");
  if (!backup) return SQLITE_ERROR;
  int status;
  do { status = sqlite3_backup_step(backup, 128); } while (status == SQLITE_OK);
  int finish = sqlite3_backup_finish(backup);
  return status == SQLITE_DONE && finish == SQLITE_OK ? SQLITE_OK : SQLITE_ERROR;
}

static void approval_metadata_backup(sqlite3_context *context, int argc, sqlite3_value **argv) {
  sqlite3 *source = sqlite3_context_db_handle(context), *output = NULL, *image = NULL;
  char *projection_path = NULL; struct stat projection_before = {0}, projection_after = {0}; int projection_created = 0;
  sqlite3_stmt *statement = NULL; struct stat before, after; int moved = -1, ok = 0, status = -1;
  const char *filename = argc == 1 && sqlite3_value_type(argv[0]) == SQLITE_TEXT ? (const char *)sqlite3_value_text(argv[0]) : NULL;
  if (!filename || filename[0] != '/' || strlen(filename) > 4096 || getuid() != geteuid()
    || lstat(filename, &before) != 0 || !S_ISREG(before.st_mode) || before.st_uid != getuid()
    || before.st_nlink != 1 || (before.st_mode & 077) != 0 || before.st_size != 0
    || sqlite3_file_control(source, "main", SQLITE_FCNTL_HAS_MOVED, &moved) != SQLITE_OK || moved != 0) goto cleanup;
  projection_path = sqlite3_mprintf("%s.metadata", filename); if (!projection_path) goto cleanup;
  int descriptor = open(projection_path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (descriptor < 0) goto cleanup;
  projection_created = 1; int identity_ok = fstat(descriptor, &projection_before) == 0;
  close(descriptor); if (!identity_ok) goto cleanup;
  if (sqlite3_open_v2(projection_path, &output, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, NULL) != SQLITE_OK) goto cleanup;
  sqlite3_limit(output, SQLITE_LIMIT_LENGTH, 2 * 1024 * 1024);
  if (sqlite3_exec(output, "PRAGMA foreign_keys=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN", NULL, NULL, NULL) != SQLITE_OK) goto cleanup;
  /* Exact schema has been verified by the caller. Defer indexes and immutable
   * triggers until after data import; do not weaken or remove source guards. */
  if (sqlite3_prepare_v2(source, "SELECT name,sql FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", -1, &statement, NULL) != SQLITE_OK) goto cleanup;
  while ((status = sqlite3_step(statement)) == SQLITE_ROW) {
    const char *name = (const char *)sqlite3_column_text(statement, 0), *ddl = (const char *)sqlite3_column_text(statement, 1);
    if (!name || !ddl || strlen(name) > 128 || strlen(ddl) > 65536
      || (strncmp(name, "approval_", 9) != 0 && strcmp(name, "security_audit_schema") != 0
        && strcmp(name, "security_audit_records") != 0 && strcmp(name, "security_audit_checkpoint") != 0)
      || sqlite3_exec(output, ddl, NULL, NULL, NULL) != SQLITE_OK) goto cleanup;

  }
  if (status != SQLITE_DONE) goto cleanup;
  sqlite3_finalize(statement); statement = NULL;
  if (sqlite3_prepare_v2(source, "SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='approval_payload_secrets' ORDER BY name", -1, &statement, NULL) != SQLITE_OK) goto cleanup;
  while ((status = sqlite3_step(statement)) == SQLITE_ROW) {
    const char *name = (const char *)sqlite3_column_text(statement, 0);
    if (!name || copy_metadata_table(source, output, name) != SQLITE_OK) goto cleanup;
  }
  if (status != SQLITE_DONE) goto cleanup;
  sqlite3_finalize(statement); statement = NULL;
  if (sqlite3_prepare_v2(source, "SELECT sql FROM main.sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name", -1, &statement, NULL) != SQLITE_OK) goto cleanup;
  while ((status = sqlite3_step(statement)) == SQLITE_ROW) {
    const char *ddl = (const char *)sqlite3_column_text(statement, 0);
    if (!ddl || strlen(ddl) > 65536 || sqlite3_exec(output, ddl, NULL, NULL, NULL) != SQLITE_OK) goto cleanup;
  }
  if (status != SQLITE_DONE) goto cleanup;
  sqlite3_finalize(statement); statement = NULL;
  if (sqlite3_prepare_v2(source, "PRAGMA main.application_id", -1, &statement, NULL) != SQLITE_OK
    || sqlite3_step(statement) != SQLITE_ROW || sqlite3_column_int(statement, 0) != 0x444f4e50) goto cleanup;
  sqlite3_finalize(statement); statement = NULL;
  if (sqlite3_exec(output, "PRAGMA application_id=1146048080; COMMIT", NULL, NULL, NULL) != SQLITE_OK
    || sqlite3_db_cacheflush(output) != SQLITE_OK) goto cleanup;
  moved = -1;
  if (sqlite3_file_control(output, "main", SQLITE_FCNTL_HAS_MOVED, &moved) != SQLITE_OK || moved != 0
    || lstat(projection_path, &projection_after) != 0 || projection_after.st_dev != projection_before.st_dev
    || projection_after.st_ino != projection_before.st_ino || projection_after.st_uid != getuid()
    || (projection_after.st_mode & 077) != 0) goto cleanup;
  if (sqlite3_open_v2(filename, &image, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, NULL) != SQLITE_OK
    || sqlite3_exec(image, "PRAGMA cache_size=-2048; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL", NULL, NULL, NULL) != SQLITE_OK
    || copy_metadata_image(image, output) != SQLITE_OK || sqlite3_db_cacheflush(image) != SQLITE_OK) goto cleanup;
  moved = -1;
  if (sqlite3_file_control(image, "main", SQLITE_FCNTL_HAS_MOVED, &moved) != SQLITE_OK || moved != 0) goto cleanup;
  if (sqlite3_close(image) != SQLITE_OK) goto cleanup;
  image = NULL;
  if (sqlite3_close(output) != SQLITE_OK) goto cleanup;
  output = NULL;
  if (lstat(filename, &after) != 0 || after.st_dev != before.st_dev || after.st_ino != before.st_ino
    || after.st_nlink != 1 || !S_ISREG(after.st_mode) || (after.st_mode & 077) != 0) goto cleanup;
  ok = 1;
cleanup:
  if (statement) sqlite3_finalize(statement);
  if (image) sqlite3_close(image);
  if (output) sqlite3_close(output);
  if (projection_created && lstat(projection_path, &projection_after) == 0
    && projection_after.st_dev == projection_before.st_dev && projection_after.st_ino == projection_before.st_ino) unlink(projection_path);
  sqlite3_free(projection_path);
  if (!ok) sqlite3_result_error(context, "approval_metadata_backup_unverified", -1);
  else sqlite3_result_int(context, 1);
}

int sqlite3_extension_init(sqlite3 *database, char **error, const sqlite3_api_routines *api) {
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  int status = sqlite3_create_function(database, "dona_file_identity_ok", 0,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, file_identity_ok, 0, 0);
  if (status != SQLITE_OK) return status;
  status = sqlite3_create_function(database, "dona_publish_mutex", 2,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, publish_mutex, 0, 0);
  if (status != SQLITE_OK) return status;
  status = sqlite3_create_function(database, "dona_approval_metadata_backup", 1,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, approval_metadata_backup, 0, 0);
  if (status != SQLITE_OK) return status;
  mutation_guard *guard = sqlite3_malloc(sizeof(*guard));
  if (!guard) return SQLITE_NOMEM;
  memset(guard, 0, sizeof(*guard));
  guard->database = database;
  guard->references = 2;
  status = sqlite3_create_function_v2(database, "dona_clock_reference", 1,
    SQLITE_UTF8 | SQLITE_INNOCUOUS, guard, clock_reference, 0, 0, release_guard);
  if (status != SQLITE_OK) { release_guard(guard); return status; }
  return sqlite3_create_function_v2(database, "dona_mutation_guard", -1,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, guard, control_mutation, 0, 0, release_guard);
}
