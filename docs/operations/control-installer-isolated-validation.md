# control installerの隔離検証と残条件

Issue #234のfeature向け部分成果。指定baseは`feature/issue-231-self-update-epoch`。mainへ統合済みとは扱わず、Issue全体の完了・本番起動・実launchdのacceptanceを主張しない。

## 今回のreceipt契約

installerの既存`verified` ledgerと成果物hashに加え、receipt writerはexact build、update schema 3、health PID/start、private startup lock、固定launchd labelの登録PID/build、`ps`開始時刻の一致を確認する。成果物再読の前後で同じprocess identityを観測し、確認中のprocess交代・ledger変更・tree変更でreceiptを作らない。保存する`process_identity`は発行時の履歴であり、後日の稼働状態やrestartの認可ではない。旧receiptの読み取り契約を変更しない。

`updater/test/control-receipt-process.test.ts`は管理下childを起動し、private UDS、lock、実PIDと開始時刻を使う。launchd登録だけは注入したfixture。childはfake Updater healthを返すため、現runtimeのready・実service・実launchdの証拠ではない。各testがchildとprivate rootを回収する。

## 検証の区分

| 障害・条件 | 検証箇所 | 残る境界 |
| --- | --- | --- |
| 同SHA socket process交代、別登録PID、旧health形式、別schema、ledger変更 | receipt process test | 実launchdと本物Updaterを使うinstaller全工程 |
| partial build、lockfile差、hash差、release mode差、same-SHA再利用 | 既存install preflight test | copy途中のkillから正規installerを再開する全工程 |
| staging cleanup、disk-full時のledger publish | 既存install preflight test | installer内の各write位置へのENOSPC注入 |
| launchctl応答喪失、登録解除timeout | 既存install preflight testの注入観測 | 実launchdの応答喪失・登録/UDS競合 |
| DB backup、旧binary復元rehearsal、復元artifact破損 | 既存install preflight test | migration失敗からinstaller自身のrollbackを通すmatrix |

## mainへ運ぶ最小差分と追加依存

今回の差分はreceipt writer、identity観測の戻り値、installerのreceipt引数、関連testのみ。#238/#239の未提出差分を前提にしない。旧worktreeからfileや設定をコピーせず、指定baseに既に含まれる#337/#339/#353のcontractを利用する。

現mainへの次段階では、この差分だけを既存mainの同helperへ適用し、必要な#234 ledger/rehearsal/restore contractをfile・call site単位で比較する。共通feature全体の移植は行わない。

確認したversion skewは次のとおり。

- featureのtemplate rendererはmainの`signed_host`保持、local approval設定、Task世代`forward_only`・schema 4のpolicy保存経路を持たない。mainでの生成・再生成時にこれらを維持する必要がある。
- featureのrequired checksにはmainの`Verify sources/web`がない。現mainのCI trust集合を維持し、旧fixtureの成功を現CIの代用にしない。
- featureのruntime testにはHerdr paneと旧job supervision契約が残る。Task/App Serverのruntime DB・socket・停止/再開の契約へ適合する検証が別途必要。
- canonical repository表記が旧`hiragram/dona`に固定されている。現`reirei-lab/dona`のremote/CI trustとの整合を専用移植時に確認する。

統合PR #341は別の未完了境界。今回のPRはその更新・mergeを行わない。全受入には正規installerをprivate DB/temp root/管理下processで通すfault harness、path/owner/mode/linkのwrite直前検証、未知processを操作しないrollback、fresh本物Updater healthとreceiptの照合が残る。production bootstrapには別承認が必要。
