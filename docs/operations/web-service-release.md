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

通常のCanonicalBuild、offline updater、maintenance reset/upgrade、installerは `sources/web` を同じrelease内でbuildする。新manifestの `lock_hashes["sources/web"]` はWeb lockfileのSHA-256を保持する。Web lockfileがない新releaseのmanifestは公開しない。

manifest readerは旧3component manifestを旧release照合のために受け入れる。これは旧releaseにWeb serviceがあることを意味しない。未知componentや不正hashは拒否する。旧updaterは4component manifestを読めないため、旧control-planeをそのまま使えるとの互換性判断はしない。既存のstage/activation契約に従い、更新対象updaterによるmanifest検証を先に行う。

## 既存control-planeの更新順序

必須CIは `Verify dispatcher`、`Verify sources/slack`、`Verify updater`、`Verify self-hosted macOS`、`Verify sources/web` の5件とする。updaterのplan/stageでは同じtarget SHAの同じmain push runに由来するterminal successを要求し、Webのmissing・failure・skipped・実行中を成功扱いしない。example policy、installerの事前検証、生成policy、新updaterで同じ集合を使用する。

旧updaterは4件、新updaterは5件の固定集合を厳密に検証する。旧binary＋新policy、新binary＋旧policyのどちらも起動時に拒否するため、稼働中のpolicyだけを先に編集しない。既存installationは通常self-updateに先立ち、[control-plane更新手順](../../scripts/install-self-update.sh)の `--upgrade-control` 経路で次の順に更新する。

1. 対象SHAの5件のCI成功と互換性を確認する。既存の非terminal update要求がある場合は更新しない。
2. updaterを停止し、旧binaryと旧policyを一緒にbackupする。
3. installerでbuildした新binaryと生成済み5件policyを停止中に配置し、検証後にupdaterを起動する。
4. 起動・health確認に失敗した場合は旧binaryと旧policyを対で復旧する。片方だけを戻さない。

上記は既存installerが行う切替順序であり、手動で稼働中configを書き換える手順ではない。実行には別途updateの承認が必要になる。maintenance reset/upgradeとoffline updaterは準備時に旧policyの集合とtargetが要求する5件の両方を検証し、新control-plane用policyへtarget集合を設定する。offline rollback用control-planeも新版binaryを使用するため5件policyと対にする。旧application release、旧state、保存済み旧policy原本は保持する。

## 未接続の境界

既存 `WebLoopbackStartup` は実HTTPS listener、OIDC、signed UDS clientを持つが、通常Dona serviceのproduction compositionは未接続である。既存multiuser Web認証を起動するにはOS credential storeと、監査anchor/clock markのprotected CAS provider、初期principal登録、固定originに対応するIdP/TLS設定が必要になる。テスト用providerは本番providerの代用にしない。

private networkの閲覧専用serviceについては[観測service手順](dashboard-observer.md)で独立した設定・pairing・起動とpointer追随を扱う。既存OIDCの認証方式やcommand/approval有効化を変更するものではない。#374の完了には実serviceとprivate HTTPS proxyを接続したinstall・preserve update・障害rollbackの通し検証が残る。未接続のcommand/approvalは `safe_off` として扱い、Web packageの配置だけで有効化済みと表示しない。実環境での起動・アクセスURL確認・本番activationはこのbuild対応の成果に含めない。
