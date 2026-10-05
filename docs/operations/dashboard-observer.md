# 別端末からDonaの作業を観測する

このserviceはTailscale等のprivate networkでHTTPS公開する閲覧専用dashboardである。接続コードを受け取った端末は、そのDonaのすべてのTaskとワーカーの会話を閲覧できる。端末ごとのTask範囲制限はない。Webから依頼、取消、再開、質問への回答、承認はできない。従来のOIDC command dashboardとは別の起動構成である。

## 設定と起動

releaseはWebとDispatcherのbuild成果、Web lockhash付きmanifestを含む必要がある。秘密を含めない設定ファイルをMacのownerだけが読める `0600` で作る。以下の値は環境に合わせた絶対パスへ置き換える。

```json
{
  "schema_version": 1,
  "origin": "https://dona.example.ts.net",
  "port": 4318,
  "control_socket": "/absolute/private/observer/control.sock",
  "dispatcher_database": "/absolute/current/dona.sqlite3",
  "runtime_socket": "/absolute/current/runtime.sock"
}
```

control socketの親とlog directoryはowner所有・mode `0700`、socket pathは100 bytes以下とする。Task DBとruntime socketは現在世代の設定から照合し、旧世代の推測値を使わない。設定のsymlinkや未知fieldは起動拒否する。

`node scripts/dashboard-service.mjs render <release> <config.json> <log-directory>` で専用plistを確認する。`install` は同じ3引数で `dev.dona.dashboard` のplistだけを配置し、`start` で起動する。`status` はlaunchd状態、`node <release>/dispatcher/dist/dashboard/cli.js status <config.json>` はowner-only control socket上のversionとsession数を返す。serviceは `127.0.0.1:<port>` だけにbindする。

Tailscale Serve等のreverse proxy側は、設定したexact HTTPS originからこのloopback portだけへ転送する。proxyはHostを設定originへ一致させる必要がある。HTTP直アクセスや任意Hostは利用対象外。forwarded user/headerを認証には使わない。Tailnet ACLで閲覧対象端末を限定し、インターネット公開・Funnelは使わない。proxy設定の変更・実ネットワーク接続は別途その環境で検証する。

## 端末の接続と解除

Macのterminalで `node <release>/dispatcher/dist/dashboard/cli.js pair <config.json>` を実行する。5分で失効する一回限りコードを、設定originへアクセスした端末の接続フォームに入力する。新コード発行は前コードを無効化する。コードはURL、設定、ログへ保存しない。CLIは非TTYへのcode出力を拒否する。

画面の「この端末を解除」でそのsessionを失効させる。Mac側の `revoke <config.json>` はすべてのsessionと未使用codeを失効させる。操作結果が不明なら自動再送せずstatusを確認する。service restartでもsessionとcodeは失効し、再接続が必要になる。

## 更新・復旧と資源

serviceは追加DBを作らず、session/codeはメモリにのみ保持する。永続資源はowner-only設定、専用plist、ログ、immutable releaseである。Task/Attempt/Result/worktree/runtime DBをWebの更新・復旧でコピー、移動、書換えしない。観測readerはSQLiteのread-only connectionだけを開く。

更新は新releaseのbuild/manifest検証後に `stop`、新releaseへの `install`、`start`、control version確認の順に行う。旧releaseと設定を保持し、障害時はWebだけをstopして旧releaseのplistを再配置する。workerを止めずにWebだけを戻せる。Task schemaが旧readerと非互換ならそのreleaseを起動せず、閲覧停止を維持する。旧cookie/sessionは復活しない。

起動時にcontrol socketが残っている場合、serviceはowner/modeとinodeを照合し、接続がECONNREFUSEDだった同じsocketだけを回収する。稼働中または接続結果が不明なsocketは拒否する。拒否時は対象serviceのlaunchd登録・実process・socket所有を照合する。未確認socketを手動で消して起動し直す手順にはしない。

version応答はservice起動の証拠であり、Tailscale経由のTLS、ブラウザ接続、runtime会話取得、preserve update/rollbackを証明しない。それぞれ隔離harnessと対象端末で検証する。package配置やこの手順の追加だけで#374/#146を完了としない。
