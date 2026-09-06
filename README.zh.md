# @deepseek-ai/dsh-comem

comem 是 DeepSeek Harness 的 Cordis 插件，用追加式记录保存分层记忆树。插件遵循模板库的函数插件导出形式，提供 name、inject、Config、apply，不提供默认导出。

每次成功的 native 或 archive compact 都创建新的 L1 节点和不可变 mem revision。父节点按顺序保存只描述 child 的 Record；当前层满时，compact 结果写回当前节点的 mem，再将完成节点交给参数化的更高层。默认 logical layer cap 是 102,400 tokens，与 physical call budget 分开配置。physical call budget 会按 Record 边界拆分 replay 背景，再合并为一个 Record 或当前层 mem；不可拆分的超大输入会失败，不会静默截断。运行时模型调用使用配置的 provider/model，archive 需要显式注入 provider；DSH 本身没有原生 session/archive 事件。

当 DSH 提供 storageDomain 时，runtime 会打开版本化的 comem domain，并在插件 fiber 销毁时关闭；测试或适配器也可以注入已经打开的 comemDomain。没有该服务时使用可追加、可重放的 JSONL 事件。comem_open 默认返回 abs，expand 返回 mem、Records、children 和来源，source 返回来源；comem_search 默认搜索 abs，comem_note 是唯一的 shared 写入入口，不会自动把 workspace 内容写入 shared。

开发命令：

    pnpm install
    pnpm run lint
    pnpm test
    pnpm run build
