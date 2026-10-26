---
description: "永続的な名前付きエージェント: 耐久 dot レコード、専用ワークスペースとホームセッション、割り当てフレーム、メモリファイル、実行時のツール許可リスト、dots Remote API。"
kind: "subsystem"
---

# Dots

[English](dots.md) | 中文

## 概述

dot は、割り当てをまたいで作業を続ける永続的な名前付きエージェントです。`@deepseek-ai/dsh-dots` は dot のライフサイクル — ディレクトリ・ワークスペース・ホームセッションの作成、Session controller 経由の割り当て配信、管理された `AGENTS.md` 契約と上限付き `MEMORY.md`、Session リストから導出する状態、アーカイブ、耐久スケジュール — を所有し、`@deepseek-ai/dsh-tool-dots` がモデル向けの 6 ツールを公開します。レコードは `dots` ストレージドメインに保存され、廃止された `$DSH_HOME/dots/registry.json` は有効化時に一度だけ取り込まれます。ライフサイクル全体を単一ホストが所有し、peer や fleet の層はありません。

## 目录

- [レコードとストレージ](#records-and-storage)
- [作成](#creation)
- [割り当て配信](#assignment-delivery)
- [状態](#status)
- [ワークスペースファイル](#workspace-files)
- [実行時のツールポリシー](#execution-time-tool-policy)
- [スケジュール](#schedules)
- [Remote API](#remote-api)
- [Cordis API](#cordis-api)
- [既知の制限と今後の作業](#known-limitations-and-deferred-work)

-----

<a id="records-and-storage"></a>
## レコードとストレージ

`dots` という名前の 1 つのドメイン（バージョン 1）が `dots` という 1 つのテーブルを持ち、`DotId` をキー、完全な `DotRecord` を値とします。表示名、目的、ディレクトリ、ホームセッション id、任意のワークスペース id、エージェントプリセット、任意の権限プリセット、任意のツール許可リスト、任意のモデル選択、作成・更新時刻、最終割り当て時刻と回数、任意のアーカイブ時刻を含みます。

保存された各行は、廃止されたファイルレジストリと同じ検証（id 形状、空でない名前と目的、絶対ディレクトリ、宣言済みプリセット、バイト上限、非負カウンタ）でデコードされるため、不正な行はライフサイクルに入るのではなくドメインのオープンを拒否します。有効化時、従来の `$DSH_HOME/dots/registry.json` はテーブルが空の間だけ取り込まれ、`registry.json.imported` に改名されます。空でないテーブルの隣に残ったファイルはログに記録され、そのまま残ります。

<a id="creation"></a>
## 作成

作成は名前（64 文字、パス区切りや制御文字を含まない）、目的のバイト上限、ツール許可リスト、要求されたプリセットとモデルをデプロイの許可リストに対して検証し、`dot-<slug>-<hex>` を採番して `<root>/<dot-id>/` と管理ファイルを作成します。レジストリがマウントされていればそのディレクトリの Workspace を登録し、要求されたプリセットでホームセッションを作成し、dot 名でタイトルを付け、権限プリセットを適用し、要求されたモデルを選択します。Workspace 登録や名前変更の失敗は警告として報告されます。セッション作成に失敗した場合、Workspace もセッションも生まれなかったディレクトリは削除され、そうでなければ残存パスが報告されます。

ルートは既定で `$DSH_HOME/dots` です。`maxDots` は有効なレコード数を制限し、アーカイブ済みの dot は数えません。

<a id="assignment-delivery"></a>
## 割り当て配信

割り当ては Session controller 経由でホームセッションを再開し、`queue` モードで 1 つのプロンプトをキューに入れます。実行中の dot は後のターンで受け取り、1 つの dot が割り当てを直列に処理します。プロンプトは `[DOT ASSIGNMENT]` ブロックとして、dot 名と id、目的、割り当て id、呼び出し元、`MEMORY.md` の上限付き末尾、タスクのバイト上限、完了報告の指示を含みます。`lastAssignedAt` と `assignmentCount` はプロンプトが受け入れられた後にのみ記録されます。

組み込みのプロンプト API は通常の `user-rpc` メッセージソースを記録するため、dot id は `source.kind === 'dot'` のセッションイベントではなくプロンプト本文に載ります。この選択は Session 形式を変えない代わりに、識別子をテキストで運びます。

<a id="status"></a>
## 状態

1 回の `sessionController.list` 読み取りで各 dot の状態を導出します。ホームセッションがターン中なら `running`、エージェントは生きているが実行中でなければ `idle`、耐久レコードだけが残っていれば `asleep`、レコードが指すセッションを controller が知らなければ `missing` です。状態は読み取るだけで保存されません。

<a id="workspace-files"></a>
## ワークスペースファイル

各 dot ディレクトリには次が含まれます:

| ファイル | 所有者 | 意味 |
|---|---|---|
| `AGENTS.md` | 管理 | 運用契約: 目的、自律性、メモリと報告の規則、プリセット、権限プリセット、許可リストの要約。目的や許可リストの変更時に書き換えられます。 |
| `MEMORY.md` | dot と更新者 | `dot_update` で追記される日付付きの耐久事実。1 回の割り当てには上限付きの末尾だけが入ります。 |
| `.dsh-dot/manifest.json` | 管理 | ダッシュボードと修復のための id、名前、作成時刻。 |
| `report.md`、`NEEDS_ATTENTION.md` | dot | 任意の完了詳細と、契約が示すエスカレーション経路。 |

`maxMemoryBytes` は割り当てに入る末尾を制限し、切り詰め時は `(older memory omitted)` マーカーを残します。

<a id="execution-time-tool-policy"></a>
## 実行時のツールポリシー

`enforceToolAllowlist` が true のとき、`tools/pre-execute` リスナーは dot のホームセッションで、ツールが dot の許可リスト（完全名または末尾 `*` プレフィックス、空リストは全ツール禁止、省略は全許可）に一致しない限り拒否します。ガードは dot 内のすべての `dot_*` ツールも拒否し、アーカイブ済み dot を拒否し、系譜が dot に至る生きた subagent セッションにも同じ許可リストを適用します。拒否理由は dot と許可パターンを示すため、モデルは回復できます。

<a id="schedules"></a>
## スケジュール

`dot_schedule` と `scheduleList`/`scheduleCreate` Remote メソッドは、耐久スケジュールを dot のホームセッションに結び付けます。Schedule サービスは任意であり、ない場合これらの操作は `dots/unavailable` で失敗し、ライフサイクルの残りは動作し続けます。dot をアーカイブすると既定でスケジュールが停止します。

<a id="remote-api"></a>
## Remote API

サービスは `ctx.dotsController` としてマウントされ、Typert Remote 名前空間 `dots` をバインドします: `list`、`create`、`assign`、`update`、`archive`、`scheduleList`、`scheduleCreate`。dot 参照は完全な id または大文字小文字を区別しない名前です。変更系の各メソッドは呼び出し元キャンセル用の省略可能な signal を受け取り、Web パネルはモデルツールと同じ操作を使います。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdotscontroller--dotscontroller"></a>

### `ctx.dotsController` — `DotsController`

Remote API over one deployment's durable dots.

```ts cordis-catalog
/**
 * List dots with live status.
 * @param request - whether to include archived records.
 * @param signal - optional caller cancellation.
 * @returns visible dots in storage order.
 */
@Remote('list') async list(request: DotsListRequest, signal?: AbortSignal): Promise<DotsListValue>

/**
 * Create one dot with its workspace directory and home session.
 * @param request - name, purpose, and optional preset/permissions/model.
 * @param signal - optional caller cancellation.
 * @returns the created dot and non-fatal warnings.
 */
@Remote('create') async create(request: DotsCreateRequest, signal?: AbortSignal): Promise<DotsCreateValue>

/**
 * Queue one assignment on a dot's home session.
 * @param request - dot reference, task text, and optional caller identity.
 * @param signal - optional caller cancellation.
 * @returns acceptance, not completion.
 */
@Remote('assign') async assign(request: DotsAssignRequest, signal?: AbortSignal): Promise<AssignResult>

/**
 * Update one dot's purpose, memory, or execution allowlist.
 * @param request - dot reference and the changes to apply.
 * @param signal - optional caller cancellation.
 * @returns the updated dot.
 */
@Remote('update') async update(request: DotsUpdateRequest, signal?: AbortSignal): Promise<DotView>

/**
 * Archive one dot, stopping its schedules and live turn.
 * @param request - dot reference and whether to stop its schedules.
 * @param signal - optional caller cancellation.
 * @returns the archive summary.
 */
@Remote('archive') async archive(request: DotsArchiveRequest, signal?: AbortSignal): Promise<ArchiveResult>

/**
 * List one dot's active schedules.
 * @param request - dot reference.
 * @param signal - optional caller cancellation.
 * @returns active schedules bound to the dot's home session.
 */
@Remote('scheduleList') async scheduleList(request: DotsScheduleListRequest, signal?: AbortSignal): Promise<DotsScheduleListValue>

/**
 * Create one durable schedule on a dot's home session.
 * @param request - dot reference plus title, prompt, and exactly one timing selector.
 * @param signal - optional caller cancellation.
 * @returns the created schedule summary.
 */
@Remote('scheduleCreate') async scheduleCreate(request: DotsScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleResult>
```

Source: [`packages/dots/dots/src/service.ts`](../../packages/dots/dots/src/service.ts)
<!-- END GENERATED cordis-surface -->

## 既知の制限と今後の作業

<a id="known-limitations-and-deferred-work"></a>

- **単一ホスト。** dot は保存したホストが所有します。peer トランスポート、fleet マージ、リモート選択はありません。
- **テキストで運ぶ dot 識別子。** 割り当ては通常のユーザーメッセージソースを使うため、dot id は専用のセッションイベントではなくプロンプトフレームに載ります。
- **モデル選択は検証のみ。** `create` は明示的な provider/model を受け取りますが、ライブカタログを公開する Remote メソッドはありません。
- **メモリは 1 ファイル。** 同時追記は controller で直列化され、割り当てにはバイト上限付きの末尾だけが入ります。
- **スケジュールには Schedule サービスが必要。** ない場合スケジュール操作は明示的に失敗し、残りのライフサイクルは継続します。
