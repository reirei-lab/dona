# 個人用dashboardの履歴とSSE再接続

Task詳細とDona本体の会話詳細は、返したsnapshotと同じ投影から `stream_cursor` を発行する。個人用BFFは `/api/tasks/{task_id}/events?attempt={attempt_id}` と `/api/conversations/main/{name}/{generation}/events` で `Last-Event-ID` を検証する。現在の端末・grant・選択したTask/Attempt/main世代に束縛した署名cursorであり、別端末や別対象への転用はできない。cursorは5分で失効し、Web再起動時も無効になる。

SSEは一回のHTTP応答につき一件の `snapshot` / `heartbeat` / `reset` 通知だけを返す。本文やruntime event列を通知へ複製せず、変更があれば現在認可で詳細を再取得する。表示更新は5秒間隔。runtimeのsequenceを次回の観測へ渡し、保持gap、sequence退行、runtime binding変更、cursor不正・期限切れでは `reset` からsnapshotを取り直す。再取得はworker起動・質問回答を伴わない。過去Attemptは保存済みbinding、mainはexact generationを使う。

一つの通知は1KB未満、ブラウザは4KBを超える応答を拒否し、同時stream取得は一件に制限する。BFFは同時接続最大32件、進行中read最大16件で受付を制限し、未完了のruntime観測は5秒、browser readは10秒で打ち切る。遅いブラウザ向けの無制限通知queueを持たない。HTTP応答の最後まで受信した通知だけを採用し、切断・不正frameでは新しいsnapshotから再接続する。

画面の戻る・進む・reloadはURL fragmentのTask/Attempt/main選択だけを復元し、本文は現在の認可から再取得する。snapshotや会話本文をbrowser storageへ保存しない。未送信の依頼フォームは一時的なネットワーク断ではページ内に保持し、認証失効・logoutでは消去する。page reloadを跨ぐ本文の永続保存はしない。応答不明のcommand receipt参照は別途sessionStorageで保持し、自動再送しない。

## 隔離した実接続の検証

`operator-runtime.spec.ts` はHTTPS browserから依頼し、実Dispatcher API、JobSupervisor、App Server runtime hostとUnix WebSocketを通って別processを起動する。Codex側だけをJSON-RPC fixtureに置き換え、進捗会話、atomic Result公開、Task terminal、画面の最終成果まで確認する。Task/Attempt/Job状態をtestから直接変更しない。閲覧による追加turnが0件、Attemptが1件、ワーカーのturnが1件であることも検査する。8件のSSE socket受信をpauseしても各frameが1KB未満であり、他の閲覧とterminal処理が進むことを確認する。

これは実Codexによる作業、実Slack送信、Tailscaleや別実端末への配備成功の証明ではない。実運用のsmokeとexact release SHAの照合は別に実施する。
