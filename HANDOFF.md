# 引き継ぎ資料（イントロクイズ）

最終更新: 2026-10-20 ／ 直近のマージ: PR #10

この資料は、前のクラウドセッションの作業を、**ブラウザを操作できるセッション**（Claude デスクトップアプリ、またはパソコンで `claude remote-control`）に引き継ぐためのものです。
新しいセッションでは「`HANDOFF.md` を読んで続きをお願い」と伝えれば再開できます。

---

## 1. プロジェクト概要

- **何か**：YouTube のイントロを聴いて曲名を当てるクイズ。ソロプレイと、オンラインの早押し対戦がある。
- **構成**：`index.html` 1ファイルだけの静的サイト（HTML / CSS / JS 全部入り）。ビルドなし。
- **バックエンド**：Firebase Realtime Database（compat SDK v10.12.2）。設定は `index.html` 内の `firebaseConfig`。
- **再生**：YouTube IFrame API。動画は黒いカバーで隠して音声だけ流す。
- **YouTube Data API**：プレイリスト取り込みと動画タイトル取得に使う。キーは `index.html` の `YT_API_KEY`。
- **サビ検出**：非公式の lemnoslife API（`yt.lemnoslife.com/videos?part=mostReplayed`）で「最も再生された部分」を取得する。
- **公開**：GitHub Pages。`main` に push すると `.github/workflows/deploy.yml` でデプロイされる。

## 2. 作業ルール（ユーザーとの取り決め）

- UI の文言とユーザーとのやりとりは**日本語**。
- 開発ブランチは `claude/inspiring-darwin-ZIrBX`。マージ済みなら、`main` から作り直して使う。
- **PR はマージまで Claude が自動で行ってよい**（ユーザーの許可済み）。ブランチに push → `main` 向け PR を作成 → そのままマージ。
- `main` にマージしないと Pages に反映されない。マージ後にブランチへ push しても反映されないので、新しい PR が必要。
- ユーザーはスマホ（参加者）と PC（ホスト）の 2 台で動作確認することが多い。

## 3. データ構造（Firebase）

```
lists/{listId}      : { name, visibility:'public'|'personal', ownerUuid, ownerName,
                        songs:[{ id, videoId, title, answers[], yomigana[], genre, chorusStart?, addedByUuid, addedByName }] }
users/{uuid}        : { name, uuid, stats:{ games, totalScore, wins } }
chorusCache/{videoId}: サビ開始秒（全部屋で共有するキャッシュ）
rooms/{roomId}      : {
  name, code, passphrase, visibility:'public'|'private', status:'lobby'|'playing'|'finished',
  hostUuid, hostName, players:{ uuid:{ uuid, name, joinedAt } },
  settings:{ listIds[], listId, genre, count, yaminabe, yaminabeGenre, handicap, hcOwnerMiss, hcOtherHit,
             chorusOn, correctPts, wrongPts, songLimit, suggestOn },
  game:{ questions[], total, current, phase:'play'|'reveal', scores:{uuid:点}, choices[](回答候補),
         rounds:{ idx:{ answerer, answererName, answererElapsed, answerStartAt, cycle, resolved,
                        lockouts:{ uuid: 解除時刻(サーバー時刻ms) },
                        attempts:{ pushId:{ uuid, name, elapsed, answer, correct } } } },
         roundResult:{ idx:{ winnerUuid, winnerName, winnerPts, answer, title, adderPenalty, ... } } }
}
```

ユーザー識別は localStorage の `iq_user`（`{uuid, name}`）。ほかに `iq_room`（リロード復帰用）と `iq_sfx`（効果音の ON/OFF）を使う。

## 4. 対戦の流れ（主要関数）

| 段階 | 関数 | ポイント |
|---|---|---|
| 入室 | `joinRoom` / `enterLobby` / `handleStartupJoin` | `?room=コード` の招待リンクと、リロード時の復帰に対応 |
| ロビー | `renderLobby` / `populateHostSettings` / `saveRoomSettings` | 設定欄はキーが同じなら上書きしない（編集中の内容を保護） |
| 開始 | `hostStartMatch` / `hostContinueMatch` / `buildPoolFromSettings` | 複数リストの選択、闇鍋、続ける（既出曲の除外あり） |
| 状態の振り分け | `renderRoomState` → `renderMatch` / `renderReveal` / `renderFinished` | Firebase が更新されるたびに再描画する |
| 再生 | `loadMatchVideo` / `unlockMatchAudio` / `matchPlayTick` | 各自1回タップして音声を解禁。上限は `currentSongLimit()` |
| 早押し | `buzz` | `rounds/{idx}` をトランザクションで更新し、先に届いた人が回答権を取る。押した端末には即座に反映される |
| 回答 | `sendAnswer` / `releaseAnswererUpdates` | **回答者本人が確定する**。正解なら `hostReveal` で採点と結果発表、誤答なら回答権を解放して5秒ペナルティ |
| ホストの保険 | `maybeHostWatchAnswerer` / `hostForcePass` / `maybeHostTimeout` | 回答者が落ちたときの強制パス。曲の時間切れで「正解者なし」にする |
| 結果発表 | `renderReveal` / `ensureChorusAndPlay` / `playMatchChorus` | サビのフェードイン・アウト。開始秒は手動指定 → 自動値 → キャッシュ → lemnoslife → 曲の中間点の順に決める |
| 終了 | `renderFinished` / `renderPodium` / `renderAwards` / `recordMyStatsOnce` | 表彰台・称号・出題曲一覧（誰が何秒で答えたか） |
| 退出 | `leaveRoom` / `cleanupMatch` | 再生を止めて各種タイマーを解除 |

時刻はすべて `serverNow()`（`.info/serverTimeOffset` で補正したサーバー時刻）で判定する。

演出は `SFX`（Web Audio で効果音を合成）、`confetti`、`showBuzzFlash`、`shakeEl` を使う。1問ごとに1回だけ鳴らす制御は `fxState` / `fxSync` で行っている。

回答の正誤判定は `normalize` で表記ゆれを吸収してから比較する。ひらがなはカタカナに寄せ、英字は小文字にし、記号・絵文字・空白は除去する。

## 5. 直近の変更

- **PR #9**：効果音、回答権のフラッシュ表示、紙吹雪、スコアのアニメーション、スマホ用の大きな早押しボタン、スペースキーでの早押し、回答候補、招待リンク、リロード復帰、再生時間の設定、表彰台と称号、ホーム画面の刷新。
- **PR #10**：
  - 早押しの遅延を短縮した。ホストが 800ms 待って判定する方式をやめ、トランザクション方式にした。同時押しは「サーバーに先に届いた人」が勝つ。以前は「曲開始からの秒数が短い人」が勝つルールだった。
  - 回答を本人が確定するようにした。
  - 自動生成ミックス（`list=RD...`）と YouTube Music のリストの取り込みに対応した。画面外の YouTube プレーヤーに読み込ませ、`getPlaylist()` で曲を取り出す。

## 6. 未確認・要テスト（実ブラウザで確認が必要）

前のセッションは YouTube と Firebase に接続できない環境だったため、以下は**実機で確認できていない**。偽の DB を使ったブラウザテストでは動作を確認済み。

- [ ] 2台での早押し：押した瞬間に回答欄が出るか。同時に押したときに片方だけが回答権を取るか。負けた側に「○○さんが回答中」と出るか。
- [ ] 誤答後のペナルティ表示（5秒）、曲の再開、他の人が押せるようになるか。
- [ ] 回答の時間切れ（20秒）で「(時間切れ)」が1回だけ記録され、曲が再開するか。
- [ ] **自動生成ミックスの取り込み**：`https://www.youtube.com/watch?v=XXXX&list=RDXXXX` 形式の URL で曲が入るか。失敗したらエラーメッセージを確認する。`fetchPlaylistIdsViaPlayer` の `cuePlaylist` のタイミングや待ち時間（15秒）の調整が必要かもしれない。
- [ ] YouTube Music のプレイリスト（`music.youtube.com/playlist?list=...`）の取り込み。
- [ ] 招待リンクで直接入室できるか。表示名が未設定の場合は、設定後に自動で入室するか。
- [ ] 参加者がリロードしたときに部屋へ戻れるか。
- [ ] iOS Safari で効果音・振動・早押しボタンが動くか（効果音は最初のタップで解禁する）。
- [ ] スマホで早押しボタンが画面下部に固定され、回答欄やキーボードと重ならないか。

## 7. 既知の課題・制限

- **ホストがリロードまたは切断すると部屋が消える**（`enterLobby` の `onDisconnect().remove()`）。リロード復帰は参加者だけ有効。ホスト権を別の人に移す仕組みは未実装。
- **Firebase のセキュリティルールが未整備**の可能性が高い（誰でも読み書きできる状態）。一般公開する前に見直しを推奨。ルールは Firebase コンソールで設定する。
- YouTube Data API のキーがソースに直書きされている。公開リポジトリなら、Google Cloud 側で HTTP リファラー制限をかけることを推奨。
- lemnoslife は非公式 API なので、止まるとサビの自動検出が「曲の中間点」にフォールバックする。
- 自動生成ミックスで取れるのは先頭の数十曲まで（YouTube の仕様）。「高く評価した動画」「後で見る」「マイミックス」は取得できない。
- Firebase 無料枠（Spark）は同時接続 100 まで。
- 音楽著作権：身内で遊ぶ分には問題ないが、不特定多数への公開には注意（ユーザーに説明済み）。

## 8. 今後の改善候補（提案済み・未着手）

- ホスト移譲（ホストが落ちても部屋を続ける）
- 4択モード、チーム戦、回答権の回数制限
- ロビーでのチャット・スタンプ、全員の「準備OK」表示
- 曲リストの複製・統合・並べ替え、JSON でのエクスポート / インポート、再生できない動画の事前チェック
- 個人の対戦履歴（得意ジャンル、平均の早押し秒数）
- ライトモード
- ファイル分割（CSS / JS を別ファイルにする。GitHub Pages のままで可能）

## 9. ローカルでの確認方法

- `file://` で開くと YouTube の多くの曲が再生できないため、必ず HTTP サーバー経由で開く。
  ```
  python3 -m http.server 8765
  # → http://localhost:8765/index.html
  ```
- 本番の Firebase につながるので、テスト用の部屋やリストはテスト後に削除する。
- 構文チェック：`<script>` の中身を抜き出して `node --check` にかける。
- 前のセッションでは、Playwright で偽の `db`（`ref().update / transaction / push().key` を持つオブジェクト）を差し込み、`renderRoomState` を呼んで早押しの流れを検証した。`db` は `let` で宣言されているので、`window.db` ではなく `db = {...}` で差し替える。
