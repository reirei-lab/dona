# 別端末からDonaの作業を観測する

この手順はTailscale等のprivate networkでHTTPS公開する、個人用dashboardの起動と観測を扱う。Macで発行した接続コードに固定されたcapabilityだけを端末へ付与する。既定の閲覧権限は、そのDonaのすべてのTaskとワーカーの会話を対象とし、端末ごとのTask範囲制限はない。Dona本体の会話と操作の権限は別途Macで明示する。

## 設定と起動

releaseはWebとDispatcherのbuild成果、Web lockhash付きmanifestを含む必要がある。秘密を含めない設定ファイルをMacのownerだけが読める `0600` で作る。以下の値は環境に合わせた絶対パスへ置き換える。

```json
{
  "schema_version": 1,
  "origin": "https://dona.example.ts.net",
  "port": 4318,
  "active_release_pointer": "/absolute/runtime/current",
  "control_socket": "/absolute/private/observer/control.sock",
  "dispatcher_database": "/absolute/current/dona.sqlite3",
  "dispatcher_socket": "/absolute/current/dispatcher.sock",
  "runtime_socket": "/absolute/current/runtime.sock"
}
```

control socketの親とlog directoryはowner所有・mode `0700`、socket pathは100 bytes以下とする。Task DBとruntime socketは現在世代の設定から照合し、旧世代の推測値を使わない。設定のsymlinkや未知fieldは起動拒否する。`active_release_pointer` は任意で、省略時は指定releaseへ固定する。指定時は既存updaterのprivate runtime/current symlinkと、同runtimeのreleases/<SHA>だけを許可する。runtime directoryはowner所有の0700とする。

`node scripts/dashboard-service.mjs render <release> <config.json> <log-directory>` で専用plistを確認する。`install` は同じ3引数で `dev.dona.dashboard` のplistだけを配置し、`start` で起動する。`status` はlaunchd状態、`node <release>/dispatcher/dist/dashboard/cli.js status <config.json>` はowner-only control socket上のversionとsession数を返す。serviceは `127.0.0.1:<port>` だけにbindする。

起動前に `node scripts/dashboard-service.mjs doctor <release> <config.json> <log-directory>` を実行する。これは設定・private socket/DB・control/log directory・Tailscaleの導入/接続状態を読むだけで、serviceやServeの設定を変更しない。`ready: true` でもsocketへの認可やHTTPS到達はまだ未検証なので、起動後のCLI `status` と端末からの確認まで行う。Tailscale以外のprivate proxyを使う場合、Tailscale項目は独立した参考情報として、そのproxyのTLS/到達を別途検証する。

`dispatcher_socket` がない旧configはrender/installで拒否される。現在世代のDispatcher設定にある `DONA_SOCKET_PATH` またはupdate policyの `dispatcher_socket` を照合して明示し、runtime socketと混同しない。socketの親directoryはcanonical pathで記述する（macOSの `/var` が `/private/var` へのsymlinkの場合なども実体を使う）。DB/socketがまだ作成されていない場合はDona本体の起動状態を確認し、dashboardのために別DBを新規作成しない。

Tailscale Serve等のreverse proxy側は、設定したexact HTTPS originからこのloopback portだけへ転送する。proxyはHostを設定originへ一致させる必要がある。HTTP直アクセスや任意Hostは利用対象外。forwarded user/headerを認証には使わない。Tailnet ACLで閲覧対象端末を限定し、インターネット公開・Funnelは使わない。proxy設定の変更・実ネットワーク接続は別途その環境で検証する。

## Tailscaleの設定手順

1. doctorが `not_installed` なら、Macと閲覧端末の両方へTailscaleを導入してログインする。`not_connected` はログイン/接続、`unavailable` はCLIの起動結果と既存設定を確認する。未導入なら[Tailscale公式のインストール手順](https://tailscale.com/download)を使う。
2. Macの `tailscale status` で接続状態と名前を確認し、`tailscale serve status` で既存の公開先を確認する。すでに同じHTTPS port/pathが使われている場合は上書きせず、空いているportを選んで設定の `origin` にもそのportを含める。
3. observerを起動・status確認後、未使用のHTTPS portに転送を設定する。以下は443が未使用でbackendが4318の場合の例。環境の既存設定を確認してから実行する。

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:4318
   tailscale serve status
   ```

4. 表示されたHTTPS URLと設定の `origin` を完全一致させる。HTTPSが未有効ならCLIが案内するtailnetの設定画面で有効にする。FunnelではなくServeを使う。
5. 閲覧端末からそのURLを開き、次のペアリング手順で登録する。未登録端末ではTaskが表示されないこと、登録後にTaskを取得できることを確認する。

macOSアプリ版で `tailscale` がPATHにない場合は `/Applications/Tailscale.app/Contents/MacOS/Tailscale` を使用できる。上記のServe設定は既存Dona installerが自動変更するものではない。[Serveの公式手順](https://tailscale.com/docs/features/tailscale-serve)、[CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve)

## 端末の接続と解除

Macのterminalで `node <release>/dispatcher/dist/dashboard/cli.js pair <config.json>` を実行する。5分で失効する一回限りコードを、設定originへアクセスした端末の接続フォームに入力する。新コード発行は前コードを無効化する。コードはURL、設定、ログへ保存しない。CLIは非TTYへのcode出力を拒否する。

画面の「この端末を解除」でそのsessionを失効させる。Mac側の `revoke <config.json>` はすべてのsessionと未使用codeを失効させる。操作結果が不明なら自動再送せずstatusを確認する。service restartでもsessionとcodeは失効し、再接続が必要になる。

## 更新・復旧と資源

BFFは追加DBを作らず、Dispatcherが既存DBにoperator/device認可を保存する。session/codeはDispatcherのメモリにのみ保持する。BFFの永続資源はowner-only設定、専用plist、ログ、immutable releaseである。Task/Attempt/Result/worktree/runtime DBをWebの更新・復旧でコピー、移動、書換えしない。観測readerはSQLiteのread-only connectionだけを開く。

pointer追随modeでは、既存updaterがpreserve updateまたはrollbackでcurrentを切り替えると、最大1秒後にWebだけを停止し、launchdがcurrent上の新binaryを起動する。切替は検出するだけでWebがupdaterを操作することはない。設定のTask DB/runtime socket pathはpreserve updateで安定している必要があり、fresh generation切替ではoperatorが再設定する。pointer不正、manifest不一致、Web binaryのない旧releaseへのrollbackでは閲覧を停止したままにし、自動復旧成功を主張しない。旧release側にobserverがなければ対応releaseへ戻すかWeb serviceをstopする。

固定release modeの更新は新releaseのbuild/manifest検証後に `stop`、新releaseへの `install`、`start`、control version確認の順に行う。旧releaseと設定を保持し、障害時はWebだけをstopして旧releaseのplistを再配置する。workerを止めずにWebだけを戻せる。Task schemaが旧readerと非互換ならそのreleaseを起動せず、閲覧停止を維持する。旧cookie/sessionは復活しない。

起動時にcontrol socketが残っている場合、serviceはowner/modeとinodeを照合し、接続がECONNREFUSEDだった同じsocketだけを回収する。稼働中または接続結果が不明なsocketは拒否する。拒否時は対象serviceのlaunchd登録・実process・socket所有を照合する。未確認socketを手動で消して起動し直す手順にはしない。

version応答はservice起動の証拠であり、Tailscale経由のTLS、ブラウザ接続、runtime会話取得、preserve update/rollbackを証明しない。それぞれ隔離harnessと対象端末で検証する。package配置やこの手順の追加だけで#374/#146を完了としない。


### Dispatcher側の端末認可への移行

`dispatcher_socket` は所有者専用の Dispatcher UDS を明示する必須設定です。旧設定はこの値を追加してから再起動します。BFF 自身は接続コードや session を保存せず、Dispatcher で認可し、本文を返す直前にも session を再照合します。BFF 起動時は設定された HTTPS origin を Dispatcher へ固定し、既存 session を失効させます。

Mac の `pair` コマンドには `--capability` を複数指定できます。省略時は `tasks:read` と `conversations:worker:read` だけです。Dona 本体の会話は `--capability conversations:main:read` を明示します。指定した集合がそのコードの付与範囲になるため、Task も見る場合は各 read capability を併記してください。操作権限も Mac で明示した範囲に限られます。

`revoke --device <device_id>` は対象端末を失効させ、引数なしは全端末を失効させます。`status` は Dispatcher の認可状態を表示します。接続コードは引き続き対話 terminal の `pair` だけに表示し、service log へ記録しません。

## 起動後の診断

`node dispatcher/dist/dashboard/cli.js doctor /absolute/path/dashboard.json` は設定の検証後、private Dispatcher socketを通してDB・Runtime接続・operator・外部承認の保護状態を個別に照会する。`external.configured: false` は外部承認未設定であり、利用可能を意味しない。設定済みの機能が不健全な場合は終了code 1となる。これはHTTPSの別端末到達や実Slack操作の成功とは別の確認である。

外部承認を有効にするDispatcherは `DONA_LOCAL_APPROVAL_CONFIG` にMacで管理する0600の設定ファイルを指定する。設定・署名・Keychain整合性の検査に失敗したときは外部承認を利用不可として診断に示す。他のTask閲覧やDispatcher受付を、初期設定の不足だけで停止しない。provisionは常駐serviceから自動実行しない。

通常installerで外部承認設定を導入するには、`DONA_LOCAL_APPROVAL_CONFIG=/absolute/private/approval.json` を `scripts/install-self-update.sh` へ渡す。private設定を検証してDispatcher plistへ保存し、次回は未指定でも同じgenerationの設定を保持する。既存の `config/dispatcher.env` に同変数を設定する経路も有効で、plistの明示値が優先する。設定導入はKeychain provisionや外部承認readyの証明ではない。署名、対話provision、現在scopeとhealthの照合は[署名host手順](dispatcher-signed-host.md)と[承認運用手順](local-external-approval.md)に従う。

## 会話・実行内容の表示

会話の詳細には依頼本文、Codexの応答、ツール名、コマンド、テキスト出力・エラー、変更ファイル・移動先と追加/削除行数、終了コード・所要時間を表示する。項目の有無はApp Serverの返す情報に従う。Taskの依頼は現在のAttemptではTaskの最新objective、過去のAttemptでは当時のobjectiveを表示し、会話閲覧権限が必要。追加指示のワーカー受理が未確認の場合は注意を表示する。観測時刻は取得時点で、実行開始時刻の代わりにはしない。長い入力・出力は折りたたみ、表示上限による省略を明示する。

内部のDona処理契約は依頼部分だけを抽出し、reasoning、認証用metadata、ツール引数全体、画像や生の変更差分は公開しない。既知のcredential形式や管理用pathは保存・表示前に除去する。既知のcredential名への代入を含む表示fieldは、複数行の値も漏れないよう内容全体を省略する。コマンド・入力から既知の認証情報を検出した項目は、裸の秘密値が返る可能性を考慮して出力・エラーも省略する。認証ファイルの5field形式と一致する一部の診断文も保守的に省略する。ただし任意の出力に含まれる未知の秘密を完全検出する保証ではないため、会話閲覧権限は自分の信頼する端末にだけ付与する。分割されたtokenを本文として流さないため、本文は完成したitem/historyから反映する。

旧版で内容を省略して保存した履歴は、App Serverから再取得できる場合に限り詳細が増える。取得できない旧履歴には詳細未保存を表示し、更新だけで過去の出力が復元されたとは扱わない。
