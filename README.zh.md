# comem

comem 是 DeepSeek Harness 的 Cordis 插件，用追加式记录保存分层记忆树。插件遵循模板库的函数插件导出形式，提供 name、inject、Config、apply，不提供默认导出。

每次成功的 native 或 archive compact 都创建新的 L1 节点和不可变 mem revision。父节点按顺序保存只描述 child 的 Record；当前层满时，compact 结果写回当前节点的 mem，再将完成节点交给参数化的更高层。默认 logical layer cap 是 102,400 tokens，与 physical call budget 分开配置。physical call budget 会按 Record 边界拆分 replay 背景，再合并为一个 Record 或当前层 mem；不可拆分的超大输入会失败，不会静默截断。运行时模型调用使用持久化的 `comem` 设置 namespace。Web 客户端提供 Comem 设置页，可在“使用当前会话模型”和“使用单独配置的模型”之间选择；修改会实时用于 append、layer 和 archive 压缩。选择当前会话时，Comem 使用该 session 最近一次 request header 的 provider/model；可配置失败次数，达到次数后回退到设置页中的自定义 provider/model。选择单独配置时，直接使用该自定义模型。archive 仍需要显式注入 provider，DSH 本身没有原生 session/archive 事件。

Comem 只使用 DSH 的 `storageDomain` 服务：runtime 会在创建 engine 前打开版本化的 `comem` domain，并在插件 fiber 销毁时关闭。如果服务不存在、domain 无法打开或返回不可用的 domain，插件不会启动；不再使用 `storageDir`、`comemStore`、`comemDomain` 或 JSONL fallback。使用 DSH 默认 JSON backend 时，记录位于 `$DSH_HOME/storages/comem/events/`。comem_open 默认返回 abs，expand 返回 mem、Records、children 和来源，source 返回来源；comem_search 默认搜索 abs，comem_note 是唯一的 shared 写入入口，不会自动把 workspace 内容写入 shared。bundle patch 默认只插入 `comem` 主插件，因为普通的 `dsh-base`/`dsh-web-app` profile 不提供 `invariants` 服务。`./invariant` 仍然作为独立导出提供给包含 `@deepseek-ai/dsh-invariants` 的 profile；不要在没有该服务时无条件插入 companion 行。

开发命令：

    pnpm install
    pnpm run lint
    pnpm test
    pnpm run build
