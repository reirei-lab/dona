# Web serviceのrelease資源と導入境界

Web dashboardの機能と、本番で起動できるserviceの構成は別に検証する。現時点のrelease buildには `sources/web` の `npm ci`、typecheck、buildとlockfile hashを含める。build成功は認証provider、listener、Dispatcher接続のreadinessを証明しない。

## 永続資源の所有

| 資源 | 所有者 | 更新・復旧時の扱い |
| --- | --- | --- |
| Task、Attempt、Result、worktree | Dispatcher / runtime | Webのrestart・設定更新で削除、移動、再作成しない |
| App Serverのprocess・thread・generation | runtime host | Webから起動・resume・stopしない |
| Webのprincipal、失効generation、session tombstone、audit | DispatcherのWeb認可境界 | owner、schema、audit anchorを照合し、snapshotだけの巻戻しで失効を取り消さない |
| TLS秘密鍵、OIDC/service key、identity index key | OS credential store | release directory・manifest・通常DB backupへ含めない。旧identity index versionを欠落させない |
| Web build成果・package-lock hash | immutable release | release SHAと一緒に検証する |

資源の追加は名前、所有者、schema、保存先、backup方針、復旧検証を明記する。旧世代の「DBが4個/5個」という数だけで追加資源の保護を証明しない。既存offline updaterの添字付きDB inventoryへWeb DBを単に末尾追加しない。

## 配置と互換性

通常のCanonicalBuild、offline updater、installerは `sources/web` を同じrelease内でbuildする。新manifestの `lock_hashes["sources/web"]` はWeb lockfileのSHA-256を保持する。Web lockfileがない新releaseのmanifestは公開しない。

manifest readerは旧3component manifestを旧release照合のために受け入れる。これは旧releaseにWeb serviceがあることを意味しない。未知componentや不正hashは拒否する。旧updaterは4component manifestを読めないため、旧control-planeをそのまま使えるとの互換性判断はしない。既存のstage/activation契約に従い、更新対象updaterによるmanifest検証を先に行う。

## 未接続の境界

既存 `WebLoopbackStartup` は実HTTPS listener、OIDC、signed UDS clientを持つが、通常Dona serviceのproduction compositionは未接続である。既存multiuser Web認証を起動するにはOS credential storeと、監査anchor/clock markのprotected CAS provider、初期principal登録、固定originに対応するIdP/TLS設定が必要になる。テスト用providerは本番providerの代用にしない。

private networkの閲覧専用serviceについては[観測service手順](dashboard-observer.md)で独立した設定・pairing・起動とpointer追随を扱う。既存OIDCの認証方式やcommand/approval有効化を変更するものではない。#374の完了には実serviceとprivate HTTPS proxyを接続したinstall・preserve update・障害rollbackの通し検証が残る。未接続のcommand/approvalは `safe_off` として扱い、Web packageの配置だけで有効化済みと表示しない。実環境での起動・アクセスURL確認・本番activationはこのbuild対応の成果に含めない。
