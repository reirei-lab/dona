#import "security-keychain-cas.h"
#include "sqlite3ext.h"
#include <unistd.h>
SQLITE_EXTENSION_INIT1

// In-process port only. There is no command, socket, generic IPC endpoint or
// runtime credential provisioning. A separate interactive operator function owns
// first provisioning; the embedding operations frontend owns admission;
// Security.framework still requires its signed executable's entitlement.
static void exchange(sqlite3_context *context, int argc, sqlite3_value **argv) {
    @autoreleasepool {
        if (argc != 1 || getuid() != geteuid() || sqlite3_value_type(argv[0]) != SQLITE_TEXT) {
            sqlite3_result_error(context, "keychain_port_unverified", -1); return;
        }
        int length = sqlite3_value_bytes(argv[0]);
        if (length < 1 || length > 32768) {
            sqlite3_result_error(context, "keychain_port_unverified", -1); return;
        }
        NSData *input = [NSData dataWithBytes:sqlite3_value_text(argv[0]) length:(NSUInteger)length];
        NSData *output = DonaKeychainCasProcessRequest(input);
        if (output == nil || output.length < 1 || output.length > 16384) {
            sqlite3_result_error(context, "keychain_port_unverified", -1); return;
        }
        sqlite3_result_text(context, output.bytes, (int)output.length, SQLITE_TRANSIENT);
    }
}

static void provision(sqlite3_context *context, int argc, sqlite3_value **argv) {
    @autoreleasepool {
        if (argc != 1 || getuid() != geteuid() || !isatty(STDIN_FILENO) || sqlite3_value_type(argv[0]) != SQLITE_TEXT) {
            sqlite3_result_error(context, "keychain_provision_unverified", -1); return;
        }
        int length = sqlite3_value_bytes(argv[0]);
        if (length < 1 || length > 16384) { sqlite3_result_error(context, "keychain_provision_unverified", -1); return; }
        NSData *output = DonaKeychainProvisionRequest([NSData dataWithBytes:sqlite3_value_text(argv[0]) length:(NSUInteger)length]);
        if (!output || output.length > 16384) { sqlite3_result_error(context, "keychain_provision_unverified", -1); return; }
        sqlite3_result_text(context, output.bytes, (int)output.length, SQLITE_TRANSIENT);
    }
}

int sqlite3_extension_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
    SQLITE_EXTENSION_INIT2(api);
    (void)error;
    int result = sqlite3_create_function(db, "dona_keychain_exchange", 1, SQLITE_UTF8 | SQLITE_DIRECTONLY,
        NULL, exchange, NULL, NULL);
    if (result != SQLITE_OK) return result;
    return sqlite3_create_function(db, "dona_keychain_provision", 1, SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL, provision, NULL, NULL);
}
