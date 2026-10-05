static constexpr const char* kBootstrap = R"DONAJS(
const { pathToFileURL, fileURLToPath } = require('node:url');
const { realpathSync } = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const entry = realpathSync(process.argv[1]);
const root = realpathSync(path.resolve(path.dirname(process.execPath), '../Resources/release'));
const inside = filename => filename.startsWith(root + path.sep);
if (!inside(entry)) throw new Error('dispatcher_host_entry_outside_bundle');
function checked(url) {
  if (url.startsWith('node:')) return;
  if (!url.startsWith('file:') || !inside(realpathSync(fileURLToPath(url))))
    throw new Error('dispatcher_host_module_outside_bundle');
}
registerHooks({
  resolve(specifier, context, next) { const result = next(specifier, context); checked(result.url); return result; },
  load(url, context, next) { checked(url); return next(url, context); }
});
Object.defineProperty(process, 'donaHost', { value: 'signed-v1' });
import(pathToFileURL(entry).href).catch(() => {
  process.stderr.write('dispatcher_host_entry_failed\n'); process.exitCode = 1;
});
)DONAJS";
