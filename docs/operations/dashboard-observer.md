# 別端末からDonaの作業を観測する

このserviceはTailscale等のprivate networkでHTTPS公開する閲覧専用dashboardである。接続コードを受け取った端末は、そのDonaのすべてのTaskとワーカーの会話を閲覧できる。端末ごとのTask範囲制限はない。Webから依頼、取消、再開、質問への回答、承認はできない。従来のOIDC command dashboardとは別の起動構成である。

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
  "runtime_socket": "/absolute/current/runtime.sock"
}
```

control socketの親とlog directoryはowner所有・mode `0700`、socket pathは100 bytes以下とする。Task DBとruntime socketは現在世代の設定から照合し、旧世代の推測値を使わない。設定のsymlinkや未知fieldは起動拒否する。`active_release_pointer` は任意で、省略時は指定releaseへ固定する。指定時は既存updaterのprivate runtime/current symlinkと、同runtimeのreleases/<SHA>だけを許可する。runtime directoryはowner所有の0700とする。

`node scripts/dashboard-service.mjs render <release> <config.json> <log-directory>` で専用plistを確認する。`install` は同じ3引数で `dev.dona.dashboard` のplistだけを配置し、`start` で起動する。`status` はlaunchd状態、`node <release>/dispatcher/dist/dashboard/cli.js status <config.json>` はowner-only control socket上のversionとsession数を返す。serviceは `127.0.0.1:<port>` だけにbindする。

Tailscale Serve等のreverse proxy側は、設定したexact HTTPS originからこのloopback portだけへ転送する。proxyはHostを設定originへ一致させる必要がある。HTTP直アクセスや任意Hostは利用対象外。forwarded user/headerを認証には使わない。Tailnet ACLで閲覧対象端末を限定し、インターネット公開・Funnelは使わない。proxy設定の変更・実ネットワーク接続は別途その環境で検証する。

## Tailscaleの設定手順

1. Macと閲覧端末の両方でTailscaleにログインする。未導入なら[Tailscale公式のインストール手順](https://tailscale.com/download)を使う。
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

serviceは追加DBを作らず、session/codeはメモリにのみ保持する。永続資源はowner-only設定、専用plist、ログ、immutable releaseである。Task/Attempt/Result/worktree/runtime DBをWebの更新・復旧でコピー、移動、書換えしない。観測readerはSQLiteのread-only connectionだけを開く。

pointer追随modeでは、既存updaterがpreserve updateまたはrollbackでcurrentを切り替えると、最大1秒後にWebだけを停止し、launchdがcurrent上の新binaryを起動する。切替は検出するだけでWebがupdaterを操作することはない。設定のTask DB/runtime socket pathはpreserve updateで安定している必要があり、fresh generation切替ではoperatorが再設定する。pointer不正、manifest不一致、Web binaryのない旧releaseへのrollbackでは閲覧を停止したままにし、自動復旧成功を主張しない。旧release側にobserverがなければ対応releaseへ戻すかWeb serviceをstopする。

固定release modeの更新は新releaseのbuild/manifest検証後に `stop`、新releaseへの `install`、`start`、control version確認の順に行う。旧releaseと設定を保持し、障害時はWebだけをstopして旧releaseのplistを再配置する。workerを止めずにWebだけを戻せる。Task schemaが旧readerと非互換ならそのreleaseを起動せず、閲覧停止を維持する。旧cookie/sessionは復活しない。

起動時にcontrol socketが残っている場合、serviceはowner/modeとinodeを照合し、接続がECONNREFUSEDだった同じsocketだけを回収する。稼働中または接続結果が不明なsocketは拒否する。拒否時は対象serviceのlaunchd登録・実process・socket所有を照合する。未確認socketを手動で消して起動し直す手順にはしない。

version応答はservice起動の証拠であり、Tailscale経由のTLS、ブラウザ接続、runtime会話取得、preserve update/rollbackを証明しない。それぞれ隔離harnessと対象端末で検証する。package配置やこの手順の追加だけで#374/#146を完了としない。
