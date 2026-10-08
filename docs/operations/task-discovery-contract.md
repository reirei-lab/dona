# Task discoveryの先行contract

Issue #170の部分成果。`task-discovery-port.ts`はtrusted composition root向けの型とdefault-deny portだけを提供する。API/MCPへの配線、実grant評価、候補選択、writeの実行は提供しない。portの注入をMCP引数として公開しない。

## 採用済み境界と未採用境界

現行mainの#166はauthorityとdisclosureを分離する。#168のgrant operationsは`status/read/steer/cancel/merge/production`であり、`discover`を含まない。status/readをdiscoverへ対応付ける契約は未採用なので、grant repositoryもissuerも変更しない。

#143の`DispatcherDatabase.listWebJobs`は現在のWeb identityで認可した後にlimitとcursorを計算する共有query正本。Slack discovery向けのprincipal・exact binding・discover grant・destinationをそのqueryへ渡すadapter契約は未採用である。このPRではproduction pagination、別DB、旧list fallbackを追加しない。

port実装者は現在のverified principal、tenant/workspace、exact task/Issue/repository bindingとrevision、grant有効期間・revoke・revision、disclosure destinationを確認し、許可したtask/job IDだけを返す必要がある。自由文titleやResultはprojection対象に含めない。候補一意性はwrite intentやoperation許可を証明しない。

## Fixtureの証拠範囲

`task-discovery-port.test.ts`のqueryはtest専用。可視集合を作ってからcount、page、truncated、cursorを計算し、不可視候補の挿入がpublic responseを変えないことを比較する。cursorの世代はserver側に置き、revoke/expiry/revision/principal変更・restartを同じpublic denyへ収束させる。query中のprincipal再確認とbinding差替えも検証する。

これは実DBやAPI/MCPの認可・restart証拠ではない。実port、共有query adapter、durable cursor、現在principalとpolicyを同じ整合境界で確認するfault test、API/MCPの選択とwrite非実行のcontract testは残acceptanceである。将来の配線前に関連Issueとmainを再取得し、discoverの意味対応を明示採用する必要がある。
