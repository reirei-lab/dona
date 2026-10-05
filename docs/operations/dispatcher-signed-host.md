# 固定payloadの署名済みDispatcher host

この配備経路は Data Protection Keychain provider 用である。Homebrew Nodeを再署名したり、署名launcherから通常Nodeを起動してentitlementを引き継がせたりしない。pinしたNode sourceのmainを専用embedderへ置換し、同じprocessで固定Dispatcher entryを実行する。

## 現在の到達点

source hash検証付きisolated build、unsigned bundle stage、profile/署名doctorを提供する。署名済みprofileによる実起動、実Keychain CAS、通常self-updateからのsigned artifact配置は別の配備gateであり、これらが未検証なら本番対応完了ではない。既存通常installerはこのbundleへ自動切替しない。profile未発行の状態で既存approvalのsafe-offを解除しない。

## 必要なidentityとprofile

Bundle IDは `dev.dona.dispatcher.host`、Keychain groupは `<AppIdentifierPrefix>dev.dona.approval`。利用者がDeveloper accountで明示App IDとKeychain Sharingを設定し、利用するDeveloper ID Application certificateを許可するmacOS Developer ID provisioning profileを取得する。profileは当該App ID/Team/groupを許可し、未失効、`ProvisionsAllDevices:true`、debug許可なしを必要とする。AppIdentifierPrefixをTeam IDと同一と推測しない。

profileは `Contents/embedded.provisionprofile`、entitlementsは `com.apple.application-identifier`、`com.apple.developer.team-identifier`、1個だけの `keychain-access-groups` とJIT許可。Hardened Runtimeを有効にする。library validation解除、DYLD injection、debug attach、unsigned executable memory許可は付けない。必要なnative dependencyは同じTeamで署名する。

## buildとstage

以下はartifact準備だけで、署名、account変更、Keychain書込み、launchd操作を行わない。入力pathは絶対pathにする。

```sh
node scripts/build-dispatcher-host.mjs /absolute/node-v24.21.0.tar.xz /absolute/new-build-dir 4
node scripts/package-dispatcher-host.mjs /absolute/new-build-dir /absolute/built-release /absolute/new-stage /absolute/profile.provisionprofile TEAM_ID PREFIX.dev.dona.approval
```

Node sourceのURL/SHA256は `native/dispatcher-host/node-source.json`。2026-10-05に公式dist indexとrelease notesを照合した24系LTS最新patchの24.21.0を使用する。更新時も公式indexとSHASUMS256を照合し、pin変更と同じcommitでhost/API/loader試験を行う。ビルドは新規directoryだけを使用し、取得済みarchiveのSHA256不一致は展開前に拒否する。build directoryの途中成果を次のbuildで自動再利用しない。

stageはDispatcherのdist/native source/node_modulesとSlack adapterのdist/node_modules、package/release metadataだけをコピーする。DB、credential、設定、git checkout全体は含めない。npmの`.bin`は不要なため除外し、その他symlink/hardlink/special fileは拒否する。

## 署名順序と検証

署名はoperatorが別途明示実行する。build/package/doctorから自動署名しない。

1. stage内のnative Mach-O（`.node`、`.dylib`、native executable）を内側から、選択したDeveloper ID Application identityで署名する。汎用的な `--deep` 署名で順序を省略しない。
2. `node scripts/refresh-dispatcher-host-native-manifests.mjs /absolute/new-stage/DonaDispatcher.app` を実行する。署名で変わったbinary hashを更新する。外側bundle署名後の実行は拒否する。
3. `DonaDispatcher.app` を同identity、Hardened Runtime、stageの `host.entitlements.plist`、trusted timestamp付きで署名する。署名後はresourcesを変更しない。
4. `node scripts/doctor-dispatcher-host.mjs /absolute/new-stage/DonaDispatcher.app TEAM_ID PREFIX.dev.dona.approval` でexpected identity/profile/entitlement/全resource/実host起動を確認する。

公開配布のnotarization/Gatekeeper検証は別途Appleの配布手順に従う。doctorの `activation_allowed` はartifact起動のgateであり、DB/runtime/Keychain/Slackの業務readyを表さない。`protected_state:not_checked` をreadyへ読み替えない。

## 固定entryと注入境界

hostは `serve`、`host-doctor`、`validate-job-result <candidate> <job_id>`、`approval-doctor|approval-provision|approval-rotate|approval-recover --config <path> --database <path>` のみを認める。rotateだけ末尾 `--next-version <version>` を要求する。approval entryが配備されていないreleaseではそのmodeは失敗する。

NodeのCLI option parsing、NODE_OPTIONS、global module paths、Inspector/SIGUSR1を無効にし、NODE_/DYLD_ hook、OpenSSL/ICU overrideを除去する。任意JS引数、`-e`、loader指定はない。JSロード前にbundleの署名/封印resources/Hardened Runtimeを検証する。worker Result validatorは固定modeを使い、汎用Node CLIへ戻さない。

macOS credential accessの境界は署名されたhost/payloadである。同一operatorが署名identityや配備ファイルを書き換えられる脅威を完全に排除するsandboxではない。署名検証だけで全OS/Keychain rollback耐性を主張しない。承認のgenesis作成/rotation/recoveryは専用CLIのTTY確認を省略しない。

## updateへ接続する際の条件

stable updaterのprepareで署名済みexact SHA bundleを作成/取得し、doctor完了後だけimmutable releaseへ配置する。署名する前のnative hashからmanifestを確定しない。launchdはbundle内 `Contents/MacOS/DonaDispatcher serve` を直接起動する。runtime/workerは独立して保持し、BFF再起動でworkerを停止しない。旧unsigned releaseへ戻る場合は外部承認をsafe-offにする。profile更新は新bundleとして扱い、active bundleをin-place変更しない。これらのinstaller/update統合と実signed smokeが未完了の間は手順だけを根拠にproduction readyとしない。

参照: [署名daemonのapp構造](https://developer.apple.com/documentation/Xcode/signing-a-daemon-with-a-restricted-entitlement)、[Provisioning profile](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles)、[Apple silicon JIT](https://developer.apple.com/documentation/Apple-Silicon/porting-just-in-time-compilers-to-apple-silicon)。

Node根拠: [公式dist index](https://nodejs.org/dist/index.json)、[24.21.0 release](https://nodejs.org/en/blog/release/v24.21.0)、[SHA256一覧](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)。
