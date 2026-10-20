# 引き継ぎ資料（イントロクイズ）

最終更新: 2026-10-20 ／ 直近のマージ: PR #12（実ブラウザでの確認と不具合修正）

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
| 早押し | `buzz` | `rounds/{idx}` をトランザクションで更新し、先に届いた人が回答権を取る。手元で先に反映しない（`applyLocally=false`）ので、押した直後は「判定中...」、約0.1秒で回答欄が出る |
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
- **PR #12**（デスクトップアプリの内蔵ブラウザで、本番の Firebase / YouTube につないで確認した結果の修正）：
  - 同時押しで負けた側に一瞬「あなたに回答権！」と回答欄が出ていた。早押しのトランザクションを `applyLocally=false` にし、押した直後は「判定中...」を出す。回答欄が出るまでは約0.1秒（通信1往復）。
  - 早押しのたびに効果音・フラッシュが2回鳴り、誤答音と画面の揺れも誤って出ていた。`lobbyRef` から届く部屋データに `id` がなく、`fxKeyOf` のキーが呼び出し元で変わっていたため。`enterLobby` で `id` を付けるようにした。
  - 全角の数字・英字や半角カナの回答が不正解になっていた。`normalize` で NFKC 正規化してから比較する（「てすと５」→「テスト5」に一致）。
  - 結果発表中にサビ開始秒の取得を待つあいだに次の問題へ進むと、**前の曲のサビが次の問題の再生を上書き**し、次の問題のサビも鳴らなくなっていた。`ensureChorusAndPlay` で問題が変わったかを確認し、別の曲の長さで中間点を計算しないようにした。
  - lemnoslife が止まっていて応答まで約21秒かかっていたため、3秒で打ち切って中間点にフォールバックする（`MOST_REPLAYED_TIMEOUT_MS`）。
  - プレイリスト取り込みで、ミックス内の同じ曲の繰り返しを「登録済み」と数えていた（例：「239曲は登録済み」）。取り込み内の重複は数えないようにした。

## 6. 確認結果（2026-10-20、PR #12）

内蔵ブラウザで、本番の GitHub Pages とローカルサーバーを別ユーザーとして2つ開き、本番の Firebase で確認した。

- [x] 2台での早押し：押した本人には回答欄が出る（修正後は約0.1秒）。もう一方には約0.13秒で「○○さんが回答中」と出る。同じミリ秒に押しても回答権を取るのは片方だけ。
- [x] 誤答後のペナルティ表示（5秒のカウントダウン後に押せるようになる）、回答権の解放と曲の再開処理。
- [x] 回答の時間切れ（20秒）で「(時間切れ)」が1回だけ記録される（ホストの保険処理との二重記録なし）。
- [x] 自動生成ミックスの取り込み（本番で56曲、約3秒）。プレーヤー経由の ID 取得も約2秒で100曲取れる。
- [x] YouTube Music の取り込み：`music.youtube.com/playlist?list=PL...`、`RDCLAK5uy_...`、`watch?v=...&list=RDAMVM...` のいずれも可。
- [x] 招待リンクで直接入室できる。表示名が未設定でも、保存すると自動で入室する。
- [x] 参加者のリロード復帰（ロビー中・対戦中の両方。結果発表画面とスコアも戻る）。
- [x] 曲の上限時間で「正解者なし」→ 結果発表、終了画面（表彰台・称号・出題曲一覧）、ロビーに戻る。
- [x] スマホ幅（375px）で早押しボタンが 124px の丸ボタンとして画面下中央に固定される（要素の位置で確認）。
- [ ] **iOS Safari の実機確認**（効果音・振動・早押しボタン、キーボードと回答欄の重なり）は未確認。この環境ではできない。

## 7. 既知の課題・制限

- **ホストがリロードまたは切断すると部屋が消える**（`enterLobby` の `onDisconnect().remove()`）。リロード復帰は参加者だけ有効。ホスト権を別の人に移す仕組みは未実装。
- **Firebase のセキュリティルールは設定済み**だが、`chorusCache` が許可されていない（読み書きとも `permission_denied`）。そのため**サビ開始秒の共有キャッシュは一度も機能していない**（毎回取得し直している。部屋の中では `game/questions/{idx}/chorusAuto` で共有されるので再生自体は動く）。使うなら Firebase コンソールで `chorusCache` の読み書きを許可するルールを追加する。`lists` / `rooms` / `users` は誰でも読み書きできる。
- YouTube Data API のキーには HTTP リファラー制限がかかっていて、`localhost` からの呼び出しは拒否される（GitHub Pages からは使える）。
- lemnoslife は非公式 API。2026-10-20 時点で応答がなく（約21秒で接続タイムアウト）、サビは「曲の1/3地点」へのフォールバックになっている。3秒で打ち切るので待ち時間は短い。
- 曲の上限時間（正解者なしの締め切り）はホストの再生位置で判定する。1問目は各自が音声を解禁したタイミングで始まるので、参加者によって聴ける時間が短くなることがある。
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
- 本番の Firebase につながるので、テスト用の部屋やリスト、`users/{uuid}` はテスト後に削除する。ブラウザの localStorage（`iq_*`）も消さないと、次に開いたときにテストユーザーが再登録される。
- 1台で2人対戦を試すときは、オリジンを分けて別ユーザーにする（例：`http://localhost:8765` と `http://player.localhost:8765`）。デスクトップアプリの内蔵ブラウザでは、`127.0.0.1` のタブで YouTube が再生を始めなかった。
- プレイリスト取り込みは API キーのリファラー制限のため、ローカルでは試せない。GitHub Pages で確認する。
- 構文チェック：`<script>` の中身を抜き出して `node --check` にかける。
- 前のセッションでは、Playwright で偽の `db`（`ref().update / transaction / push().key` を持つオブジェクト）を差し込み、`renderRoomState` を呼んで早押しの流れを検証した。`db` は `let` で宣言されているので、`window.db` ではなく `db = {...}` で差し替える。
