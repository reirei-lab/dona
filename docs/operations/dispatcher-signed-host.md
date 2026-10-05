# 固定payloadの署名済みDispatcher host

この配備経路は Data Protection Keychain provider 用である。Homebrew Nodeを再署名したり、署名launcherから通常Nodeを起動してentitlementを引き継がせたりしない。pinしたNode sourceのmainを専用embedderへ置換し、同じprocessで固定Dispatcher entryを実行する。

## 現在の到達点

source hash検証付きisolated build、bundle stage、prepare中の署名、profile/署名doctor、通常self-updateと初回切替の接続を実装している。署名・実Keychain CAS・本番切替は未実施であり、code統合や隔離テスト成功を本番対応完了とは扱わない。profile未発行の状態で既存approvalのsafe-offを解除しない。

## 必要なidentityとprofile

Bundle IDは `dev.dona.dispatcher.host`、Keychain groupは `<AppIdentifierPrefix>dev.dona.approval`。利用者がDeveloper accountで明示App IDとKeychain Sharingを設定し、利用するDeveloper ID Application certificateを許可するmacOS Developer ID provisioning profileを取得する。profileは当該App ID/Team/groupを許可し、未失効、`ProvisionsAllDevices:true`、debug許可なしを必要とする。AppIdentifierPrefixをTeam IDと同一と推測しない。

profileは `Contents/embedded.provisionprofile`、entitlementsは `com.apple.application-identifier`、`com.apple.developer.team-identifier`、1個だけの `keychain-access-groups` とJIT許可。Hardened Runtimeを有効にする。library validation解除、DYLD injection、debug attach、unsigned executable memory許可は付けない。必要なnative dependencyは同じTeamで署名する。

## 利用者がprofileを取得する手順

2026-10-05にApple公式手順と本リポジトリのprofile contractを照合した。利用者が用意する最小成果物は、このMacの既存Developer ID Application identityを許可した `.provisionprofile` である。秘密鍵のexportや共有は不要。App Storeへのapp登録・提出も不要である。

1. [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list)で利用するTeamを確認する。Identifiers → ＋ → App IDsへ進み、DescriptionをDona用と分かる名前、Explicit Bundle IDを `dev.dona.dispatcher.host` とする。同じIDが自Teamに既に存在する場合は再作成せず確認する。他Teamに登録済みで使えない場合は、任意IDへ置換して進めずhostの固定identity変更として別途判断する。[AppleのApp ID登録手順](https://developer.apple.com/help/account/identifiers/register-an-app-id/)
2. 必要なcapabilityはKeychain Sharingである。利用するaccess groupは `AppIdentifierPrefix.dev.dona.approval`。portalにKeychain Sharingの選択項目があれば有効にする。項目が独立表示されない場合も、生成profileの `keychain-access-groups` がそのgroupまたは同prefixの `*` を許可することを下記で確認する。App Groups、iCloud、Push、Data Protection checkboxを代用として有効にしない。Hardened Runtime/JITはhostの署名entitlementsで設定し、追加のAppサービスを要求しない。[対応capability](https://developer.apple.com/help/account/reference/supported-capabilities-macos/)、[Keychain共有](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps)
3. Profiles → ＋ → Distributionの **Developer ID** → Continueで上のApp IDを選び、このMacで秘密鍵を保持する **Developer ID Application** certificateを選ぶ。profile名を付け、Generate → Downloadする。Mac App Development、Mac App Store、Developer ID Installerは今回の配備契約と異なる。Developer ID profileの作成画面でcertificateが出ない場合はTeam/権限を確認する。[Apple DTSによるprofile作成案内](https://developer.apple.com/forums/thread/700341)
4. ダウンロードしたfileは最初 `~/Downloads/` に保存される。本人だけが管理する絶対path、例えば `/Users/<login>/Library/Application Support/Dona/signing/dispatcher.provisionprofile` に配置する。親directoryは0700、fileは0600、symlinkは使わず、active bundleへ直接上書きしない。profile自体に秘密鍵は含まれないが、全文や証明書・端末識別子はSlack/PRへ貼らない。Xcodeへのdouble-click登録はこのinstallerの必須条件ではない。
5. ローカルterminalで `security find-identity -v -p codesigning` を確認し、選択したDeveloper ID Applicationのidentityが有効であることを照合する。出力はMac内に留める。既存identityが使えればcertificateを新設しない。証明書だけがあって秘密鍵がない状態やcloud-only identityは、現installerのlocal `codesign` で使えるとは扱わない。

App ID/capabilityの変更にはAccount HolderまたはAdminが必要。Developer ID certificateの新規作成はAccount Holderが必要で、cloud-managed証明書には別の権限条件がある。権限不足、契約同意待ち、対象Teamを選べない場合はそのTeamの管理者へ依頼し、他Teamのprofile流用、development profile化、署名/entitlement検査の解除で続行しない。[App capabilityの権限](https://developer.apple.com/help/account/identifiers/enable-app-capabilities/)、[Developer ID certificateの権限](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)

### ダウンロード後のread-only検証

repository rootで次を実行する。`TEAM_ID`と`PREFIX.dev.dona.approval`はprivate設定に記録する実値へ置き換える。Team IDとAppIdentifierPrefixが同じとは推測しない。これはprofileの構造・期限・許可fieldの検証であり、署名済みartifactのOS起動許可やKeychain readyの証明ではない。

```sh
node --input-type=module - '/absolute/private/dispatcher.provisionprofile' TEAM_ID PREFIX.dev.dona.approval <<'JS'
import {spawnSync} from 'node:child_process';
import {decodeProvisioningProfilePlist} from './scripts/dispatcher-host-profile.mjs';
import {profileContract} from './scripts/dispatcher-host-artifact.mjs';
try {
  const [file, team, group] = process.argv.slice(2);
  const decoded = spawnSync('/usr/bin/security', ['cms', '-D', '-i', file], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (decoded.status !== 0 || decoded.error) throw Error();
  profileContract(decodeProvisioningProfilePlist(decoded.stdout), team, group);
  console.log('profile_contract: verified');
} catch {
  console.error('profile_contract: unverified');
  process.exitCode = 1;
}
JS
```

合格条件はmacOS platform、exact App IDとprefix、Team、許可group、未失効、`ProvisionsAllDevices:true`、debug許可なし。Date/Dataを含むprofile全体の `plutil -convert json` は使用しない。証明書とprofileを選んだ後のprivate署名設定JSON作成、build、署名、artifact doctorは配備担当が実施できる。profile取得だけで切替やKeychain provisionを開始せず、後述のexact plan承認・TTY確認へ進む。OSの最終検証は署名後の `doctor-dispatcher-host.mjs` と実host起動で行う。

## buildとstage

以下はartifact準備だけで、署名、account変更、Keychain書込み、launchd操作を行わない。入力pathは絶対pathにする。

```sh
node scripts/build-dispatcher-host.mjs /absolute/node-v24.21.0.tar.xz /absolute/new-build-dir 4
node scripts/package-dispatcher-host.mjs /absolute/new-build-dir /absolute/built-release /absolute/new-stage /absolute/profile.provisionprofile TEAM_ID PREFIX.dev.dona.approval
```

Node sourceのURL/SHA256は `native/dispatcher-host/node-source.json`。2026-10-05に公式dist indexとrelease notesを照合した24系LTS最新patchの24.21.0を使用する。更新時も公式indexとSHASUMS256を照合し、pin変更と同じcommitでhost/API/loader試験を行う。ビルドは新規directoryだけを使用し、取得済みarchiveのSHA256不一致は展開前に拒否する。build directoryの途中成果を次のbuildで自動再利用しない。

release manifestのNode majorがhostのpinと一致しない場合はstage前に拒否する。署名後の固定native smokeでも、埋め込みNodeからbetter-sqlite3のメモリDBとkeytar native moduleをロードし、ABI・library validationを確認する。Keychain APIやDB fileへのアクセスは行わない。

stageはDispatcherのdist/native source/node_modulesとSlack adapterのdist/node_modules、package/release metadataだけをコピーする。DB、credential、設定、git checkout全体は含めない。npmの`.bin`は不要なため除外し、その他symlink/hardlink/special fileは拒否する。

## 署名順序と検証

手動stageではoperatorが以下を明示実行する。build/package/doctor単体は署名しない。通常self-updateのprepareは明示設定されたidentity/profileを使い、同じ順序で署名とdoctorを実行する。

1. stage内のnative Mach-O（`.node`、`.dylib`、native executable）を内側から、選択したDeveloper ID Application identityで署名する。汎用的な `--deep` 署名で順序を省略しない。
2. `node scripts/refresh-dispatcher-host-native-manifests.mjs /absolute/new-stage/DonaDispatcher.app` を実行する。署名で変わったbinary hashを更新する。外側bundle署名後の実行は拒否する。
3. `DonaDispatcher.app` を同identity、Hardened Runtime、stageの `host.entitlements.plist`、trusted timestamp付きで署名する。署名後はresourcesを変更しない。
4. `node scripts/doctor-dispatcher-host.mjs /absolute/new-stage/DonaDispatcher.app TEAM_ID PREFIX.dev.dona.approval` でexpected identity/profile/entitlement/全resource/実host起動を確認する。

公開配布のnotarization/Gatekeeper検証は別途Appleの配布手順に従う。doctorの `activation_allowed` は署名とnative smokeの両方が成功したartifact起動のgateであり、DB/runtime/Keychain/Slackの業務readyを表さない。`protected_state:not_checked` をreadyへ読み替えない。

## 固定entryと注入境界

hostは `serve`、`host-doctor`、`host-native-doctor`、`validate-job-result <candidate> <job_id>`、`approval-doctor|approval-provision|approval-rotate|approval-recover --config <path> --database <path>` のみを認める。rotateだけ末尾 `--next-version <version>` を要求する。approval entryが配備されていないreleaseではそのmodeは失敗する。

`approval-operations --config <path> --database <path> --operation <operation>` は固定された保守entryだけを実行する。health/list/sweep/retention/reconcile/backup/restore-check/restore以外は拒否し、追加flagの組合せとwrite時のTTY確認は保守CLIでも検証する。実行順序・安全な復旧範囲は[外部承認の運用手順](local-external-approval.md)を参照する。

NodeのCLI option parsing、NODE_OPTIONS、global module paths、Inspector/SIGUSR1を無効にし、NODE_/DYLD_ hook、OpenSSL/ICU overrideを除去する。任意JS引数、`-e`、loader指定はない。JSロード前にbundleの署名/封印resources/Hardened Runtimeを検証する。worker Result validatorは固定modeを使い、汎用Node CLIへ戻さない。

macOS credential accessの境界は署名されたhost/payloadである。同一operatorが署名identityや配備ファイルを書き換えられる脅威を完全に排除するsandboxではない。署名検証だけで全OS/Keychain rollback耐性を主張しない。承認のgenesis作成/rotation/recoveryは専用CLIのTTY確認を省略しない。

## updateへ接続する際の条件

stable updaterのprepareで署名済みexact SHA bundleを作成/取得し、doctor完了後だけimmutable releaseへ配置する。署名する前のnative hashからmanifestを確定しない。launchdはbundle内 `Contents/MacOS/DonaDispatcher serve` を直接起動する。runtime/workerは独立して保持し、BFF再起動でworkerを停止しない。旧unsigned releaseへ戻る場合は外部承認をsafe-offにする。profile更新は新bundleとして扱い、active bundleをin-place変更しない。installer/update統合は以下の経路を使う。実signed smokeが未検証の間はproduction readyとしない。

参照: [署名daemonのapp構造](https://developer.apple.com/documentation/Xcode/signing-a-daemon-with-a-restricted-entitlement)、[Provisioning profile](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles)、[Apple silicon JIT](https://developer.apple.com/documentation/Apple-Silicon/porting-just-in-time-compilers-to-apple-silicon)。

Node根拠: [公式dist index](https://nodejs.org/dist/index.json)、[24.21.0 release](https://nodejs.org/en/blog/release/v24.21.0)、[SHA256一覧](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)。

## 既存signed世代の通常update

operatorは0600 JSONで `team_id`、`access_group`、`signing_identity_sha1`（証明書fingerprint）、`provisioning_profile`（絶対path）を用意し、installerへ `DONA_SIGNED_HOST_CONFIG` として明示する。既存policyの `signed_host` はconfig指定省略時も保持する。profile/identityの発行・書換はinstallerが行わない。

stable updaterはconfigとprofile bytesのdigestをplan hashへ結び、applyと各lease境界で再照合する。profilepath/identityを対外planへ出さない。source archiveと固定host buildはcontrol-rootの専用cacheに保持し、pin/host sourceが同じ更新では再buildせず新payloadを署名する。buildは毎回固有の一時directoryを使い、完成時だけcacheへpublishする。中断した一時名は次のbuildを妨げず、完成cacheのprovenance不一致は自動上書きしない。新runtime/host sourceでは新cache keyになる。

署名はprepare段階でだけ行い、native署名・manifest更新・bundle署名・doctor後にreleaseをpublishする。quiesceより前に失敗でき、旧workerを操作しない。restart/rollbackでもcurrent artifactとlaunchdのexact host引数を確認する。DB/Task schemaの既存rollback条件を緩和しない。

初回unsigned→signedでは、control設定に署名policyを導入しても既存Nodeのplistを保つ。update plan作成時に、現在のexact SHAと既知のNode引数、plist全体のsnapshotをprivate control-rootへ保存し、そのdigestをplan hashに束縛する。承認後にtarget signed artifactを検証し、worker安全確認とDispatcher停止確認を経て、plistをsigned host引数へ原子的に切り替える。実行途中のplist driftは拒否する。targetの完了判定にはSHAに加え `runtime_host:signed-v1` が必要となる。

初回planに束縛された旧SHAへ戻す場合だけ、保存済みの旧plistを復元できる。これはDB/Task schemaのrollback許可ではない。`rollback_safe:false`、不可逆migration、停止未確認など既存の条件を引き続き適用する。通常signed policyに汎用unsigned fallbackは設けない。stable updater管理DBはplan/snapshot digestとforward-only契約保持のためschema10へ移行し、schema9以前のbinaryへ管理DBを戻して起動しない。

## Task世代を保持するforward-only導入

現行のschema4 manifestは `rollback_safe:false` であり、従来のrollback可能updateとは別の明示設定が必要になる。新mainを取得しCI/reviewを確認した後、Mac上で次の環境設定をinstallerの `--upgrade-control <既存の絶対generation-root>` に渡す。

- `DONA_SIGNED_HOST_CONFIG`：前述のprivate署名設定JSON。
- `DONA_TASK_GENERATION_UPDATE=forward_only`：schema4を保持して進め、target起動後に自動rollbackしないことの明示設定。

rendererは `task_generation_update:{mode:"forward_only",schema:4,task_execution_version:1}` をpolicyへ保存し、以降のcontrol更新でも保持する。この段階では旧unsigned Dispatcherの引数を維持する。次に通常の `plan_self_update` を実行し、exact main SHA・plan hash・署名host切替・`activation_mode:forward_only`・`database_policy:preserve`・`automatic_rollback:false` を確認する。そのexact planへの利用者承認後だけ `apply_self_update` へ進む。profile不足・署名doctor失敗ならprepareで停止し、切替しない。

このmodeは既存とtargetのprotocol/configが同じで、双方のread/write schemaがexact4、Task execution versionが1のときだけ使える。plan、prepare、停止後のpointer変更直前にDBのuser_version4・integrity・FKをread-only検査する。v2/v3→4 migration、schema低下、DB reset、全DBのbackup/restoreは行わない。保護された承認payload/Keychain anchorのbackup制限も変えない。

target Dispatcherの開始intent以降に失敗した場合は、旧payloadの再起動やDB/Keychain巻戻しを行わず `needs_review` とする。受理不明のstartを再送せずversion healthと永続receiptで照合する。停止前の失敗は既存runtimeを維持できるが、停止後の失敗では受付停止が続く可能性がある。これはplanの自動rollback不可表示に含まれる運用上の制約である。復旧には現在のDBと保護anchorを保った修正版の前進配備を判断する。管理DBはこのplan契約を保持するschema10となり、旧updater binaryへdowngradeしない。

外部承認の設定を同時に導入する場合は、installerへ `DONA_LOCAL_APPROVAL_CONFIG=/absolute/private/approval.json` も渡す。既存の個人用operator identityとworkspaceを照合した設定を先に用意する。rendererは正規の絶対path、所有者、0600相当、単一link、symlinkでないfileと親directoryを検証し、Dispatcher plistのEnvironmentVariablesへ保存する。設定内容のscope/provider検証とgenesis作成は専用CLIの責務であり、installerはprovisionしない。

同じgenerationの次回install/control更新では、指定を省略しても既存Dispatcher plistの設定pathを再検証して保持する。変更する場合だけ新pathを明示する。初回unsigned→signedのplanはこの設定を含むplist全体へ束縛されるため、設定変更後はplanを取り直す。既存 `config/dispatcher.env` にだけ設定した値は従来どおりdotenvから読み込み、installerはそのfileを書き換えない。plistに明示した値がdotenvより優先する。署名host導入だけでは外部承認を自動的に有効化しない。
