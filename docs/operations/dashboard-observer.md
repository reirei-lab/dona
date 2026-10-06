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

会話の詳細には依頼本文、Codexの応答、ツール名、コマンド、テキスト出力・エラー、変更ファイル・移動先と追加/削除行数、終了コード・所要時間を表示する。項目の有無はApp Serverの返す情報に従う。Taskの依頼は現在のAttemptではTaskの最新objective、過去のAttemptでは当時のobjectiveを表示し、会話閲覧権限が必要。追加指示のワーカー受理が未確認の場合は注意を表示する。観測時刻は取得時点で、実行開始時刻の代わりにはしない。長い入力・出力は折りたたんで全文を表示する。履歴の取得件数や保存期間による欠落は本文とは別に明示する。

端末認証と会話閲覧capabilityを開示境界とする。メッセージ、コマンド、ツール引数、テキスト結果・エラー、ファイルパス・差分はApp Serverの内容を保持し、Dona独自の伏字・機密語判定・本文長による切り詰めは行わない。画面はHTMLを実行せず文字として描画する。履歴の取得件数・保持期間、未対応の非テキスト項目は別の契約であり、過去に伏字化して保存済みの内容は原文なしには復元できない。

旧版で内容を省略して保存した履歴は、App Serverから再取得できる場合に限り詳細が増える。取得できない旧履歴には詳細未保存を表示し、更新だけで過去の出力が復元されたとは扱わない。

### 会話画面のレイアウトとMarkdown

デスクトップでは左側にDona本体・Taskの一覧と依頼・承認操作、右側に選択した会話を表示する。両側は独立してスクロールし、接続状態と更新ボタンは画面上部に固定する。狭い画面では一覧と会話を上下に配置し、それぞれのスクロールを維持する。キーボードでは各領域にフォーカスしてPage Up / Page Downで移動できる。

依頼本文、ユーザー・Codexのメッセージ、実行結果はMarkdownとして表示する。見出し、強調、箇条書き、チェックリスト、引用、コード、GFMテーブルとリンクに対応する。横幅を超える表やコードはその部分だけ横スクロールできる。コマンド、ツール入力・出力、エラーはテキスト表示を維持する。

Markdownは同梱したMarkedで解析し、許可した要素だけをDOMとして生成する。生のHTMLは文字として表示し、画像は代替テキストだけを表示する。リンクは認証情報を含まないHTTP・HTTPS・mailtoの絶対URLに限定し、別タブで開く。外部スクリプトや画像の自動読み込みは行わない。

会話の状態・識別子・実行履歴は上部の情報パネルに集約し、依頼原文と実行結果は折りたたんで表示する。折りたたみの開閉は同じ会話の定期更新時にも保持する。その下では、連続する同じ`turn_id`の入力・応答・ツール実行をひとまとまりにする。IDがない旧履歴ではユーザー入力を区切りにする。各まとまりは番号を表示せず、余白と区切り線で示す。

### 発言・ツール実行の日時

Codex 0.160.0のApp Serverでは、`item/started.startedAtMs`と`item/completed.completedAtMs`はミリ秒、履歴の`Turn.startedAt`と`Turn.completedAt`は秒単位のUnix timestampである。DonaはこれらをUTCへ正規化して保持し、ブラウザのタイムゾーンで表示する。発言は完了日時（なければ開始日時）、ツールは開始・完了の両方を表示する。

通知の`occurred_at`はApp Server由来、`observed_at`はDonaの受信観測日時として分離する。旧記録の観測日時しかない場合は「観測」と明示する。個別日時がなく履歴のターン開始日時だけがある場合は「ターン開始」とし、個別の発生日時には置き換えない。どちらもなければ「日時未記録」とする。過去に捨てた個別通知の日時は、この変更だけでは復元できない。

状態表示は会話一覧・情報パネル・実行履歴・ツール項目で色付きの丸に統一する。実行中は青、入力・承認待ちや要確認は黄、完了は緑、失敗は赤、待機・停止・取消などはグレーの輪郭で示す。状態名と待機理由は丸へのホバー、キーボードフォーカス、読み上げで確認できる。発光や常時点滅は行わない。

Task一覧・Dona本体一覧の日時は「更新」「観測」の接頭辞を付けず、「たった今」「3分前」「2時間前」などの相対時刻で表示する。一覧の定期取得に合わせて再計算し、正確な日時はホバーと`time`要素の日時属性に保持する。

### コードブロックの配色

言語指定のあるMarkdownコードブロックはShikiの`monokai`で着色する。TypeScript / TSX、JavaScript / JSX、JSON、Shell、Python、Swift、YAML、HTML、CSS、diff、SQLと同梱grammarのaliasに対応する。未指定・未対応の言語、16,384文字または500行を超えるコード、解析失敗時は本文を変えず通常表示に戻す。ツールの生出力には言語を推測して付けない。

`npm run generate:shiki`で固定したShiki依存とJavaScript正規表現engineを単一bundleへ生成する。build・typecheck・test・test:browserの前処理でも生成し、成果物をWebのdistへ同梱する。実行時のCDN通信、WASM、eval、HTML文字列の挿入、inline styleは使用しない。ShikiのtokenをDOMのtextContentと固定theme由来のCSS classへ変換し、scriptのCSP hashで許可する。Shikiの色は生成済みstylesheetにまとめる。


### Mermaid図

`mermaid`のfenced code blockは同梱Mermaidのstrict modeで図にする。フローやシーケンスを画面に馴染むダーク配色で表示し、既定は全体が収まる幅、「原寸で表示」では図内を横スクロールできる。下の「ソースを表示」から記法を確認できる。構文エラー、16,384文字超、設定directive・frontmatterを含む場合はソースを保持して図だけをエラー表示する。

生成SVGはscript・外部image・リンクを除去し、Blobの画像として表示する。図のクリックhandlerは実行しない。描画用のinline CSSが必要なため、observerページのCSPはstyleだけinlineを許可し、画像はBlobに限定する。外部style・外部画像・外部scriptは許可しない。scriptは引き続きhashで固定する。図のcacheは最大24件で、認証失効やprivate表示の消去時に破棄する。

ファイル変更はファイルごとに開閉し、変更前・変更後の行番号、追加行の緑背景、削除行の赤背景とMonokaiの構文着色で表示する。Add/DeleteはApp Serverの本文、Updateはunified diffを扱う。差分本文・ファイル数には独自の省略・redactionを適用せず、長い差分はスクロールで全文を表示する。構文着色の上限を超える場合も本文は通常の文字として残す。旧履歴など本文がない場合だけ未記録と明示する。開閉状態は更新時に保持する。「差分の原文」からApp Serverの本文をそのまま確認できる。

右ペインは会話を開いたとき・新しい会話内容の取得時に末尾へ追従する。入力・結果・差分などの開閉と同じ内容の定期取得では閲覧位置を保持する。初回や新着に伴う遅延描画には追従するが、開閉操作後の遅延描画では移動しない。左ペインのスクロール位置は変えない。
