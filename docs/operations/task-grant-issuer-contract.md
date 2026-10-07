# Task grant issuerの未接続契約

Issue #169の部分成果。`task-grant-plan.ts`は値codecのみで、本人intentを認証するadapter、永続発行receipt、grant issuerを実装したことにはならない。

## exact plan

version、instance/tenant、本人intent event、requesterのidentity/authz revision、現在Task/Attempt、policy revision、idempotency key、有効期間、put/revoke commandをstrict schemaで固定する。putは#168のgrant schemaを再利用し、exact resource集合、Epic membership、operation、destination、parent revisionを保持する。集合順序をASCII canonicalへ揃え、domain-separated SHA-256を計算する。approval参照はplan自身のhashを参照するためsemantic commandから分離する。codecは現policyや本人性を評価しない。Task/Attemptは証明対象の実行identityであり、grantのresource集合は別のexact Task集合である。

証拠schemaはapproval/intent event、principal、Task/Attempt、policy revision、identity/intent proof参照、検証時刻と期限を要求する。receipt schemaはscope、key、plan hash、approval event、Task/Attempt、grant revisionとcommit時刻を要求する。どちらも値検証であり、構造化JSONをverified proofや成立済みreceiptとして採用してはならない。

## safe-offと後続lane

ADR 0006は端末operatorの外部operation承認を定義するが、権限変更をこの承認で解禁しない。Task grant exact scopeの本人intentを証明し、issuer権限を与える採用済みadapterは未確認である。`unavailableTaskGrantIssuer`はinitialize/put/revokeとbindingをすべて拒否する。production composition rootやAPI/MCPへ接続せず、fixture証拠を発行capabilityにしない。端末operatorをSlack requesterへ変換しない。

後続はadapter採用後に#166のcurrent authority/disclosureと#168の保護時計・監査transactionを同じwriter boundaryで照合する。plan/hashとproofの各field一致、current binding/policy/expiry、issuer-only admissionを検証し、発行・縮小委譲・revokeのreceiptをgrant変更と同じ保護transactionへ保存する必要がある。同scope/keyの同planは保存済みreceipt、異planはconflictとし、response loss後はread-only lookupへ戻す。現行codecには永続write、lookup、proof検証、receipt再生、conflict処理はない。

#20の承認必須operationをgrantで解禁しない。grant成立receiptは外部operation成功を意味しない。未接続operationのsafe-off、gateway接続、restart/response loss・policy/expiry競合の統合試験、実provider/実機/production検証は残作業であり、Issue acceptanceは変更しない。
