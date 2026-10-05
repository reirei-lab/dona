// 固定 entry のみを実行する Node embedder。署名検証より前に JS を実行しない。
#include "node.h"
#include "dona_host_bootstrap.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <mach-o/dyld.h>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>
#include <cstdlib>
#include <unistd.h>
#include <crt_externs.h>

static bool signedBundle(const std::string& bundle) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(nullptr,
    reinterpret_cast<const UInt8*>(bundle.data()), bundle.size(), true);
  SecStaticCodeRef code = nullptr;
  SecRequirementRef requirement = nullptr;
  bool valid = url && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess &&
    SecRequirementCreateWithString(CFSTR("anchor apple generic and identifier \"dev.dona.dispatcher.host\""),
      kSecCSDefaultFlags, &requirement) == errSecSuccess &&
    SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures |
      kSecCSCheckNestedCode, requirement) == errSecSuccess;
  CFDictionaryRef info = nullptr;
  if (valid) valid = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) == errSecSuccess;
  if (valid) {
    auto ent = static_cast<CFDictionaryRef>(CFDictionaryGetValue(info, kSecCodeInfoEntitlementsDict));
    auto flags = static_cast<CFNumberRef>(CFDictionaryGetValue(info, kSecCodeInfoFlags));
    uint32_t bits = 0;
    valid = ent && CFGetTypeID(ent) == CFDictionaryGetTypeID() && flags &&
      CFNumberGetValue(flags, kCFNumberSInt32Type, &bits) && (bits & 0x10000) &&
      !CFDictionaryContainsKey(ent, CFSTR("com.apple.security.get-task-allow")) &&
      !CFDictionaryContainsKey(ent, CFSTR("com.apple.security.cs.disable-library-validation")) &&
      !CFDictionaryContainsKey(ent, CFSTR("com.apple.security.cs.allow-dyld-environment-variables"));
    if (valid) {
      auto groups = static_cast<CFArrayRef>(CFDictionaryGetValue(ent, CFSTR("keychain-access-groups")));
      valid = groups && CFGetTypeID(groups) == CFArrayGetTypeID() && CFArrayGetCount(groups) == 1;
    }
  }
  if (info) CFRelease(info);
  if (requirement) CFRelease(requirement);
  if (code) CFRelease(code);
  if (url) CFRelease(url);
  return valid;
}
int main(int argc, char** argv) {
  // No option is passed to Node's generic CLI parser.
  const std::string mode = argc > 1 ? argv[1] : "";
  const bool validator = mode == "validate-job-result";
  const bool approval = mode == "approval-doctor" || mode == "approval-provision" ||
    mode == "approval-rotate" || mode == "approval-recover";
  if ((!approval && !validator && (argc != 2 || (mode != "serve" && mode != "host-doctor"))) ||
      (validator && argc != 4) ||
      (approval && (argc != (mode == "approval-rotate" ? 8 : 6) ||
        std::string(argv[2]) != "--config" || !std::filesystem::path(argv[3]).is_absolute() ||
        std::string(argv[4]) != "--database" || !std::filesystem::path(argv[5]).is_absolute() ||
        (argc == 8 && std::string(argv[6]) != "--next-version")))) {
    std::cerr << "dispatcher_host_mode_invalid\n"; return 64;
  }
  uint32_t size = 0; _NSGetExecutablePath(nullptr, &size);
  std::vector<char> executable(size);
  if (_NSGetExecutablePath(executable.data(), &size)) return 78;
  std::filesystem::path binary;
  std::error_code path_error;
  binary = std::filesystem::canonical(executable.data(), path_error);
  if (path_error) return 78;
  auto contents = binary.parent_path().parent_path();
  if (binary.filename() != "DonaDispatcher" || binary.parent_path().filename() != "MacOS" ||
      contents.filename() != "Contents" || !signedBundle(contents.parent_path().string()) ||
      !std::filesystem::is_regular_file(contents / "embedded.provisionprofile")) {
    std::cerr << "dispatcher_host_signature_unverified\n"; return 78;
  }
  if (std::string(argv[1]) == "host-doctor") {
    std::cout << "{\"signature\":\"verified\",\"protected_state\":\"not_checked\"}\n"; return 0;
  }
  // Environment hooks cannot alter module resolution or start a debugger.
  std::vector<std::string> hooks;
  for (char** e = *_NSGetEnviron(); *e; ++e) {
    const std::string key(*e, std::string(*e).find('='));
    if (key.rfind("NODE_", 0) == 0 || key.rfind("DYLD_", 0) == 0) hooks.push_back(key);
  }
  for (const auto& key : hooks) unsetenv(key.c_str());
  for (const auto* key : {"NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "NODE_EXTRA_CA_CERTS",
                         "ICU_DATA", "OPENSSL_CONF", "OPENSSL_MODULES", "SSLKEYLOGFILE"}) unsetenv(key);
  const std::string entry = (contents / (validator ? "Resources/release/dispatcher/dist/job-result-validate.bundle.mjs" : approval ? "Resources/release/dispatcher/dist/approval/local-native-cli.js" :
    "Resources/release/dispatcher/dist/cli.js")).string();
  std::vector<std::string> args{binary.string(), entry, approval ? mode.substr(9) : "serve"};
  if (validator) { args.resize(2); args.emplace_back(argv[2]); args.emplace_back(argv[3]); }
  if (approval) for (int i = 2; i < argc; ++i) args.emplace_back(argv[i]);
  auto init = node::InitializeOncePerProcess(args, {
    node::ProcessInitializationFlags::kDisableNodeOptionsEnv,
    node::ProcessInitializationFlags::kDisableCLIOptions});
  if (init->early_return()) return init->exit_code();
  int exit_code = 1;
  {
    std::vector<std::string> errors;
    auto flags = static_cast<node::EnvironmentFlags::Flags>(node::EnvironmentFlags::kOwnsProcessState |
      node::EnvironmentFlags::kTrackUnmanagedFds | node::EnvironmentFlags::kNoGlobalSearchPaths |
      node::EnvironmentFlags::kNoCreateInspector | node::EnvironmentFlags::kNoStartDebugSignalHandler);
    auto setup = node::CommonEnvironmentSetup::Create(init->platform(), &errors, args,
      std::vector<std::string>{}, flags);
    if (!setup) { node::TearDownOncePerProcess(); return 78; }
    v8::Locker locker(setup->isolate());
    v8::Isolate::Scope isolate_scope(setup->isolate());
    v8::HandleScope handle_scope(setup->isolate());
    v8::Context::Scope context_scope(setup->context());
    auto loaded = node::LoadEnvironment(setup->env(), kBootstrap);
    if (!loaded.IsEmpty()) exit_code = node::SpinEventLoop(setup->env()).FromMaybe(1);
    node::Stop(setup->env());
  }
  node::TearDownOncePerProcess();
  return exit_code;
}
