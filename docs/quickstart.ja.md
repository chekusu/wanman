# Quickstart

[English](quickstart.md) | [中文](quickstart.zh.md) | **日本語**

ここでは、あなたのマシン上の任意の git リポジトリに対して wanman を初回実行する完全な手順を解説します。

## 1. 前提条件

- **Node.js 20+** と **pnpm 9+**（`corepack enable && corepack prepare pnpm@9.15.0 --activate`）。
- **git**。
- 認証済みの Claude Code CLI *もしくは* Codex CLI — wanman はこれらをエージェントのサブプロセスとして spawn し、それらが既に持つ認証に依存します。
  - Claude Code: `@anthropic-ai/claude-code` をグローバルインストールし、ログインフローを実行します（`claude` を実行してプロンプトに従う）。
  - Codex: `@openai/codex` をグローバルインストールし、Codex CLI のドキュメントに従ってサインインします。
- **任意の既存 git リポジトリ** — エージェントに読み書きさせてよいもの。wanman はそれを隔離されたワークツリーにコピーし、あなたの汚れた作業コピーを変更することはありません。

オプション:
- クロスラン記憶を使いたい場合は `@sandbank.dev/db9` brain アダプタ — [architecture.ja.md](architecture.ja.md#brain--persistence) を参照してください。

## 2. Clone、install、build

```bash
git clone git@github.com:chekusu/wanman.git wanman.dev
cd wanman.dev
pnpm install
pnpm build
```

`pnpm build` は workspace の各パッケージをビルドし、CLI のエントリポイント `packages/cli/dist/index.js` を生成します。ソース開発中は `pnpm --filter @wanman/cli exec wanman ...` を使い、単一ファイル bundle が必要な場合だけ `pnpm --filter @wanman/cli standalone` で `packages/cli/dist/wanman.mjs` を生成してください。

ローカルでの反復開発には CLI を `npm link` しておくと便利です:

```bash
cd packages/cli
npm link
wanman --help
```

## 3. git リポジトリを引き継ぐ

任意の既存 git プロジェクトのルートから:

```bash
cd /path/to/any/git/repo
wanman takeover .
```

起こること:
1. wanman はローカル状態を保持するために、リポジトリ内に `.wanman/` を作成します。
2. 現在の `HEAD` から `.wanman/worktree/` を展開し、エージェントがあなたの汚れた作業ツリーではなくクリーンなスナップショットに対して操作するようにします。
3. 自動選択された `127.0.0.1` のポートでスーパーバイザーを起動し、ヘルス確認を待ちます。
4. 隔離された `.wanman/home/` 以下でエージェント（デフォルトでは Claude Code サブプロセス）を spawn し、シェルプロファイルの変更があなたの実際の `$HOME` に漏れないようにします。
5. takeover はフォアグラウンドに留まり、エージェントの活動をストリーミング表示します。

`--runtime` で runtime を選択できます:

```bash
wanman takeover . --runtime claude   # デフォルト
wanman takeover . --runtime codex
```

## 4. matrix と対話する

2 つ目のターミナル（同じシェルなので、設定されていれば `WANMAN_URL` を継承し、未設定ならデフォルトの `http://localhost:3120` を使用）で:

```bash
wanman agents                              # 登録済みエージェントとその状態を一覧表示
wanman send ceo "Build me a sample TODO API"
wanman watch                               # スーパーバイザーイベントをライブ配信
```

`send` は CEO の受信箱に follow-up メッセージを置きます。現在進行中の作業を中断させたい場合は `--steer` を使ってください:

```bash
wanman send ceo --steer "Stop — focus on the API, not the landing page"
```

返信を読み（配信済みとしてマーク）するには:

```bash
wanman recv --agent ceo
```

## 5. takeover のデリバリーループを把握する

matrix の起動後、ローカル takeover の標準ワークフローは次のとおりです:

1. CEO が目標を task と change capsule に分解します。
2. Dev エージェントは `wanman/<task-slug>` ブランチでスコープ内の変更を行い、coverage メモ付きの PR を作成します。
3. PR 本文または CI が変更対象ファイルで 95% 以上の coverage を示したときだけ、CTO が review を開始します。
4. 承認後に PR がマージされ、task と capsule の状態は `.wanman/` に記録され続けます。

## 6. artifact を確認する

エージェントは `wanman artifact put` を通じて、構造化された artifact — 調査サマリ、計画、財務モデルなど — を生成します。これらを閲覧するには:

```bash
wanman artifact list                # 新しい順、全エージェント
wanman artifact list --agent ceo    # 生成者でフィルタ
wanman artifact get <id>            # 本文とメタデータの全体
```

artifact の命名と品質に関する規約は [`packages/core/skills/artifact-naming/SKILL.md`](../packages/core/skills/artifact-naming/SKILL.md) および [`artifact-quality/SKILL.md`](../packages/core/skills/artifact-quality/SKILL.md) にあります。

task と initiative も同様に確認できます:

```bash
wanman task list
wanman task get <task-id>
wanman initiative list
```

## 7. クリーンアップ

takeover のために wanman が作成するものはすべて、対象リポジトリ内の `.wanman/` 配下にあります:

```
.wanman/
  worktree/   エージェントが実際に編集するクリーンなチェックアウト
  home/       エージェントサブプロセス用の隔離された $HOME
  agents/     エージェントごとのワークスペースディレクトリ（output、scratch）
  wanman.db   SQLite ストア: messages、context、tasks、artifacts、...
  logs/       スーパーバイザーおよびエージェントのログ
```

リポジトリの状態をリセットするには、`wanman takeover` を停止（Ctrl+C）してから:

```bash
rm -rf .wanman
```

あなたの実際の作業ツリーには一切触れていません — wanman は `.wanman/` の内部にしか書き込んでいません。

## 8. 次のステップ

- JSON-RPC プロトコル、メッセージ優先度、エージェントのライフサイクルを理解したい場合は [architecture.ja.md](architecture.ja.md) を参照してください。
- 貢献したい場合は [CONTRIBUTING.ja.md](../CONTRIBUTING.ja.md) を参照してください。
