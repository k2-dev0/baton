# model-router

メインエージェントが同じタスクの途中で自律的にモデルを切り替えて作業を自動続行するローカル中継

## 起動

起動したいディレクトリに移動して起動する

```sh
cd /Users/[user_name]/[directory] /Users/[user_name]/model-router/bin/model-router
```

カレントディレクトリで起動したい場合は `cd` を省略する

```sh
/Users/[user_name]/model-router/bin/model-router
```

`app` オプションをつけるとデスクトップアプリと中継機能が起動する

```sh
/Users/[user_name]/model-router/bin/model-router app
```

## 設定

- `config.json` は本番用・Git管理対象外です。`config_sample.json` はひな形
- 対象ディレクトリの path を `enabledRepositories` に絶対パスで登録する
- `config.json` は対象ディレクトリや実行ファイルの場所など、中継の起動設定だけを管理する。モデルや思考量、追加設定の変更にファイル編集は不要
- モデルと設定は呼び出し側がリクエストで指定する。中継独自のモデル一覧やモデル別の既定値は持たず、切り替え先と対応する思考量は起動時にCodexから取得したカタログで確認する
- リクエストの設定は、Codexの実行開始要求へまとめて渡す。項目の追加に中継のコード変更は不要。項目名・値は使用中のCodexが対応するものを指定する（[公式仕様](https://learn.chatgpt.com/docs/app-server#turns)）。未対応項目が有効になるわけではない
- `effort` の個別処理は、モデルが対応する思考量の確認と、Codexの作業モード内の思考量との同期用。追加設定の転送先を限定する処理ではない。設定一式は続行時の実行開始要求へ渡す
- 通常の開始要求はそのまま渡し、モデルや設定を補完しない。切り替え時も中継独自の既定値は補わない。省略した追加設定はCodexの既定・引き継ぎ動作に従うため、モデル間で戻したい値もリクエストで明示する
- タスク識別・会話入力・権限・作業場所・作業指示など、中継が維持する制御項目は切り替えリクエストから上書きできない。不正な指定は中断前に拒否する
- Codexが設定を受け付けても、モデル側でそのまま使われる保証とは異なる。0.153.4の実機では `summary: "concise"` の受付通知を確認した一方、実行記録は `summary: "auto"` だった。中継は値を書き換えず送信する
- 設定ファイルの編集は、中継の次回起動時に読み込まれる
- 配布元のモデル選択基準は AI に指示、もしくは設定する
- 起動するCodex自身から実験的機能を含む通信仕様を生成し、中継に必要な操作・項目・基本的な型・実行状態を確認する。仕様生成の失敗・5秒の時間切れ・必須機能の欠落は理由を表示して起動を拒否する。検査ではタスクを作らず、推論も行わない
- この検査は中継が使う通信契約の確認であり、将来のCodexの動作すべてを保証するものではない。通信方式自体が変わった場合は中継側の対応が必要

## 切り替えツールの呼び出し

### リクエスト形式

```json
{"model":"gpt-6-astra","config":{"effort":"high"}}
```

`switch_main_model` に上記のオブジェクトを渡す。`config` はファイル名ではなく、その呼び出しで適用する設定。追加設定も同じオブジェクトに指定できる。

```json
{"model":"gpt-6-astra","config":{"effort":"high","personality":"friendly","summary":"concise"}}
```

- `model`、`config`、`config.effort` は必須。`effort` の省略・空文字・`null` は既定値へ置き換えず、中断前にエラーを返す
- Codexのカタログにないモデル、存在しない設定項目、Codexの仕様と異なる型・列挙値、対象モデルが対応しない思考量、タスクや権限の変更指定も中断前に拒否する。カタログを取得できない場合も切り替えない
- `effort` 以外の省略項目はCodexの既定・引き継ぎ動作に任せる。オブジェクト値は項目ごとの置換であり、再帰的なマージはしない
- モデルが同じでも設定変更を受け付け、同じタスクで続行する。他のタスクや `config.json` は変更しない
- 受付可能な設定はインストール済みCodexの通信仕様から取得する。追加項目ごとの許可リスト編集は不要。ただし、中継が解析できない検証規則が加わった場合は起動時に拒否し、対応が必要になる

### レスポンス形式

成功時と中断前の失敗時では、結果の受け取り方が異なる。

#### 成功時：続行先へ渡す結果

成功時は元の実行区間を終了し、同じタスクの続行先へ結果を渡す。元のツール呼び出しに `success: true` を返してそのまま進める方式ではない。続行要求の `toolOutput.name` は `switch_main_model`、`toolOutput.output` は次のJSONを文字列化した値になる。

```json
{
  "model": "gpt-6-astra",
  "config": {
    "effort": "high",
    "personality": "friendly",
    "summary": "concise"
  },
  "status": "applied",
  "message": "Continue the original task from this successful switch; do not repeat completed work. The preceding interruption was performed by model-router, not the user."
}
```

- `model`：切り替え先のモデルID
- `config`：リクエストで指定され、続行要求へ渡した設定。中継独自の補完は行わない。Codexが引き継いだ値や内部で補完した値、モデル側の実効値を取得したものではない
- `status`：`applied`。続行先はこの結果を受け取り、未完了の作業を再開する
- `message`：続行の指示。中断はユーザーではなく中継が行ったことを伝える

#### 中断前の失敗時：ツールへの失敗応答

例えば `{"model":"gpt-6-astra","config":{}}` を渡すと、他の実行条件に問題がなければ次の応答を返す。`id` は元のツール呼び出し要求のID。

```json
{
  "id": "tool-call-id",
  "result": {
    "success": false,
    "contentItems": [
      {
        "type": "inputText",
        "text": "request.config: missing required effort"
      }
    ]
  }
}
```

`result.success` は `false`、`result.contentItems[].text` に拒否理由を返す。設定不正などの受付拒否ではモデル・設定を変更せず、タスクも中断しない。エラー文言は理由により変わるため、固定文言との一致を成功・失敗判定に使わない。

#### 中断後に続行が失敗した場合：クライアントへのエラー通知

元の実行区間が終了済みのため、通常のツール失敗応答ではなく、デスクトップ／CLI側へ `error` 通知を送る。以下は続行要求が失敗した場合の例。

```json
{
  "method": "error",
  "params": {
    "threadId": "task-id",
    "turnId": "interrupted-turn-id",
    "willRetry": false,
    "error": {
      "message": "Model switch did not continue: <Codexのエラー理由>",
      "codexErrorInfo": null,
      "additionalDetails": null
    }
  }
}
```

`threadId` は対象タスク、`turnId` は中断した実行区間のID。中継は自動再試行しない。設定の更新だけが既に成功している場合もあるため、中断前の拒否と違い、変更前の状態が保たれているとは限らない。

### エージェントへの指示例

```text
- 選択先のモデルまたは設定が現在と異なる場合だけ、専用ツール switch_main_model({"model":"モデルID","config":{"effort":"思考量"}}) を直接呼ぶ。config.effort は必須。例: switch_main_model({"model":"gpt-6-astra","config":{"effort":"high"}})。追加設定は config 内に指定する。同じモデルでも設定変更なら呼び出してよい。他のツールと承認の完了を待ち、単独で呼ぶ。コマンド探索・変更理由の提出は不要。
```

## 記録と検証

- タスク・適用モデルの永続化はエージェント本体に任せる
- 診断ログは `~/Library/Application Support/codex-model-router/router.jsonl`
- `CODEX_MODEL_ROUTER_CONFIG`、`CODEX_MODEL_ROUTER_STATE_DIR`、`CODEX_MODEL_ROUTER_INNER_CODEX` で試験用の設定・保存先・実行ファイルを指定できる

```sh
npm test
npm run check
# インストール済みCodexの通信仕様を確認（推論なし）
./bin/model-router check
# 実際のモデルを使用し、利用枠を消費する試験
MODEL_ROUTER_LIVE=1 npm test -- -t '実機で同一タスク'
```
