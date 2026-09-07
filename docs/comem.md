# comem 设计文档（草案 v1.3）

> 状态：待评审。
>
> 本版统一层与节点的命名：L1、L2、L3 只表示层；L1_node、L2_node、L3_node 表示泛化节点；L1-1、L1-2、L2-1 等表示具体节点。
> 核心追加规则是：压缩新子节点时只输出它的 Record。初始 L2_node 的首个 Record 背景为空；L2_node 满层后新建的下一个 L2_node，其首个 Record 临时使用上一个 L2_node.mem 作背景；该 Record 写入后，后续只重放当前 L2_node.Records。
> 上游需求见 comem.md。

---

## 术语约定

本文严格区分 layer 和 node：

- **L1、L2、L3……只表示层**。例如 L1→L2 表示 L1 层与 L2 层之间的关系；“L2 层满”表示 L2 层的逻辑容量达到阈值。
- **L1_node、L2_node、L3_node……表示泛化节点**。例如 L1_node.mem 表示任意 L1 层节点的 mem。
- **L1-1、L1-2、L2-1、L3-1……表示具体节点**。例如 L2-1.children 表示具体的 L2-1 节点的 children。
- 除层关系、层容量和层级算法名称外，不使用裸的 L1、L2、L3 表示节点。
- 节点字段必须使用 L1_node.field、L2_node.field 或具体的 L1-X.field、L2-X.field 形式；层标签本身不承担节点字段。
- **Records 是父层节点持久化的有序记录集合，Record 是其中的一条记录**；Record 不是节点、层，也不是临时拼接材料。
- **currentMaterial 不再是存储字段**。comem 不在 L2_node、L3_node 或其他节点中保存它；L2 层需要满层 compact 时，按 order 重放当前 L2_node 的 Records，临时生成 L2_compactInput，调用结束后丢弃。追加调用通常直接重放当前 L2_node.Records；只有满层后新建 L2_node 的首个 Record，才临时读取上一个 L2_node.mem。该 Record 写入后不再读取其他 L2_node.mem。

---

## 0. 核心定义

comem 是 DSH 专用的 TypeScript 插件。它监控 DSH 上下文中已经发生的 compact；会话归档时，comem 自动执行一次 compact。两种入口产生的 compact 都先成为新的 L1_node.mem。

一个节点的核心内容是 mem 和 abs，树关系与 provenance 是附属结构：

~~~text
L1_node / L2_node / L3_node = {
  mem: 一次 compact 的结果，详细记忆
  abs: 该节点的摘要，默认展示
  children / Records / provenance: 结构与来源
}
~~~

comem 的主流程分为三个阶段：

~~~text
1. 产生 compact，创建 L1_node，把 compact 写入 L1_node.mem

2. 找到当前 active L2_node，确定本次 Record 的一次性背景：
   - 当前 L2_node 已有 Records：按 order replay 当前 L2_node.Records；
   - 当前 L2_node 是满层后新建且还没有 Record：临时读取上一个已完成 L2_node.mem；
   - 这是该子树的第一个 L2_node：背景为空。
   以这个背景压缩新的 L1_node.mem；输出只描述这个 L1_node，
   再把输出作为 Record 持久化到当前 L2_node.Records。
   Record 写入后，丢弃上一个 L2_node.mem 的临时背景；后续不再读取其他 L2_node.mem。

3. 根据 L1_node、它在 L2_node 中的 Record 和 L2_node 的背景信息，
   为这个 L1_node 生成 L1_node.abs。
~~~

追加阶段的实际含义是：

~~~text
子树第一次创建 L2-1 时：
L2-1.Records = []

第一个 L1_node 到来时：
appendBackground = empty
Record-1 = compact(
  background = appendBackground,
  target = L1_node.mem,
  instruction = “只输出 L1_node.mem 的压缩内容”
)
persist(L2-1.Records += Record-1)

L2-1 达到容量后：
compact(replay(L2-1.Records, order))
    ↓
写入 L2-1.mem，L2-1 sealed
    ↓
创建新的 active L2-2，L2-2.Records = []

L2-2 的第一个 L1_node 到来时：
rolloverBackground = read(L2-1.mem)（只用于这一次 Record）
Record = compact(
  background = rolloverBackground,
  target = L1_node.mem,
  instruction = “只输出 L1_node.mem 的压缩内容”
)
persist(L2-2.Records += Record)
discard(rolloverBackground)

L2-2 后续接收 L1_node 时：
appendBackground = replay(L2-2.Records, order)
Record = compact(
  background = appendBackground,
  target = L1_node.mem,
  instruction = “只输出 L1_node.mem 的压缩内容”
)
persist(L2-2.Records += Record)
~~~

L2 层达到容量时才构造层级 compact 的输入：

~~~text
L2_compactInput = replay(L2_node.Records, order)
compact(L2_compactInput)
    ↓
写入同一个 L2_node.mem
~~~

必须保证：

- appendBackground 和 rolloverBackground 都只作为模型的只读上下文；
- 初始 L2_node 的第一个 Record 背景为空；满层后新建的 L2_node 仅在第一个 Record 使用上一个 L2_node.mem；
- 一个 L2_node 写入第一个 Record 后，后续 Record 只使用当前 L2_node.Records，不再读取其他 L2_node.mem；
- Record 只保留当前 L1_node.mem 的压缩内容，不复制父节点背景；
- Record 与 L2_node→L1_node 的 child edge 按同一顺序持久化；
- L2 层达到约 100K 后，才对重放得到的 L2_compactInput 执行层级 compact，结果写入当前 L2_node.mem；
- L2_node 完成后进入 L3 层时，L3 层与 L2 层之间复用同一套规则；
- 默认读取 abs，需要细节时读取 mem；mem、Record 和原始来源都不因摘要展示而删除。

---

## 1. 目标、边界与容量

### 1.1 目标

1. 只针对 DSH，不编写其他 Agent 平台的适配代码。
2. 使用 TypeScript 插件形式，遵守 DSH 的插件导出形态。
3. 复用 DSH compact 的结果和生命周期，不复刻 OptMem 的固定字节限制。
4. 每一次独立 compact 创建一个新的 L1_node.mem，再按层关系进入树。
5. 每个节点区分详细 mem 与默认 abs，并支持从 abs 展开到 mem。
6. 完整定义 L1→L2；L3 及以上只按相同规则递归。
7. 不把 workspace 内的项目细节自动写入 shared；shared 仍只接受 comem_note。

### 1.2 非目标

- 不替换、接管或修改 DSH 原生 compaction provider；
- 不把一个节点的 mem 与该节点的 abs 混为一个字段；
- 不把多个 L1_node 合并成一个 L1_node；它们应当作为多个 child 进入同一个 L2_node；
- 不把 L2 层满后的 compact 结果错误地写成 L3_node.mem；
- 不把跨 Session 的树压缩伪装成 DSH 原生 compactRegion；
- 不因默认只展示 abs 而删除 mem、Record 或原始 Session 日志；
- 不自动把整棵记忆树注入用户会话 surface。

### 1.3 容量术语

comem 使用两个不同的预算：

- **logical layer cap**：默认约 100K tokens，精确默认值为 512K × 20% = 102,400 tokens，用于判断当前层是否需要满层 compact；
- **physical call budget**：一次实际模型调用可接受的输入预算，由 context window、系统提示词、工具、背景和输出预算共同决定。

“L2 层满 100K”表示按 order 重放 L2_node.Records 得到的 L2_compactInput 达到 logical layer cap，不是所有路由模型的 attention capacity 声明，也不是 L2_node.mem 的输出长度限制。

---

## 2. L1 层与 L2 层的节点模型

### 2.1 L1 层：一次 compact 创建一个 L1_node

L1 层是叶子层。任何一次成功的 context compact 或 archive compact 都创建一个新的 L1_node：

~~~text
compact result C
    ↓
L1_node
├── L1_node.mem = C
└── L1_node.abs = 后续生成
~~~

L1_node.mem 的来源有两种：

| 来源 | 触发方式 | 结果 |
|---|---|---|
| context compact | comem 监控到一次完整的 DSH compaction | 创建新的 L1_node，写入 native compact 结果 |
| archive compact | Session 归档，comem 自动执行 compact | 创建新的 L1_node，写入 archive compact 结果 |

同一个 Session 可以产生多个具体 L1_node，例如 L1-1、L1-2。后一次独立 compact 不能覆盖前一个具体节点的 mem；幂等只针对同一个 compact 操作的重复事件或同一个 archive 操作的重复通知。

### 2.2 L2 层：L2_node 接收并压缩 L1_node

L2 层是 L1 层的父层。一个具体的 L2_node，例如 L2-1，负责按顺序接收多个具体 L1_node，例如 L1-1、L1-2。

新建 active L2_node 时，L2_node.Records 为空。这里要区分两种新建情况：

1. 这是该子树的第一个 L2_node，例如 L2-1。第一个 L1_node 到来时没有任何预设材料，背景为空；
2. 上一个 L2_node 已经满层并写入 mem，例如 L2-1.mem，随后创建新的 L2_node，例如 L2-2。L2-2 仍然从空的 Records 开始，但它的第一个 Record 必须临时使用 L2-1.mem 作为 rollover background。

rollover background 不是 L2-2 的初始材料，也不是 L2-2 的字段。它只为 L2-2 的第一个 Record 提供边界连续性；这个 Record 持久化后，L2-2 后续的 Record 只重放 L2-2.Records，不再读取 L2-1.mem 或其他 L2_node.mem。

L2_node 接收一个新的 L1_node 时，执行的不是单纯的 children 数组追加，而是以下操作：

~~~text
if L2_node.Records is not empty:
    appendBackground = replay(L2_node.Records, order)
else if previous completed L2_node.mem exists:
    appendBackground = previous completed L2_node.mem
    mark this as one-time rollover background
else:
    appendBackground = empty

Record = compact(
  background = appendBackground,
  target = L1_node.mem,
  instruction = “在已有 L2_node 内容的基础上追加压缩；
                 只输出 L1_node.mem 的压缩内容”
)

持久化 Record 到 L2_node.Records
持久化 L2_node→L1_node 的 child edge（order）
丢弃本次 appendBackground；后续只使用当前 L2_node.Records
~~~

在上述流程中，L2-1 的第一个 Record 使用 empty background；L2-2 在 L2-1 满层后创建，因此 L2-2 的第一个 Record 使用 L2-1.mem 一次。两者都没有把背景内容复制进新节点的字段。

每一个 Record 都必须满足：

1. 只描述当前 L1_node.mem；
2. 不复制、重写或删除追加前已经存在的 Records；
3. 有自己的边界、child reference、mem revision 和 order；
4. 与 L2_node→L1_node 的 child edge 一起持久化并具备幂等性。

### 2.3 L2 层达到容量后的处理

L2_node 的层级 compact 输入不是一个持久化字段，而是由当前 L2_node 的 Records 按顺序重放得到：

~~~text
L2_node.Records
  = [Record-1, Record-2, ...]
       ↓ replay(order)
L2_compactInput
       ↓ 达到 logical layer cap
compact(L2_compactInput)
       ↓
写入同一个 L2_node.mem
~~~

L1-1 到来之前，初始 L2-1.Records 为空，所以 L2-1 的第一个 Record 使用空背景。L2-1 满层后创建的 L2-2 也从空的 Records 开始，但 L2-2 的第一个 Record 使用 L2-1.mem 作为一次性 rollover background；该 Record 写入 L2-2.Records 后，L2-2 的 L2_compactInput 只由 L2-2.Records 重放得到。

L2 层达到约 100K 时，结果属于当前 L2_node 自己，不创建新的 L3_node.mem。L2_node 的 children、Records、历史 mem revision 和来源仍然保留；满层 compact 只产生该 L2_node 的新 mem revision。

如果一次满层调用超过 physical call budget，可以按 L1_node 边界分批重放和 compact，最后合并为一个 L2_node.mem。分批不会创建额外的 L1_node、L2_node 或 L3_node。

### 2.4 L1 层到 L2 层的完整关系

~~~text
L2-1（初始 active L2_node）
├── Records = [Record-1, Record-2, ...]
├── 第一个 Record：background = empty
├── L2-1.mem = 满层 compact(replay(L2-1.Records))
└── sealed

L2-1.mem ──仅用于 L2-2 的第一个 Record 的 rollover background──▶ L2-2
                                                                    ├── Records = []
                                                                    ├── 第一个 Record：background = L2-1.mem（一次）
                                                                    └── 后续 Record：background = replay(L2-2.Records)
~~~

L2-1 满层后，L2-1.mem 仍然是一个完整的 L2 层节点，并按正常流程进入更高层；它不会被搬进 L2-2 的 Records。L2-2 的第一个 Record 只借用 L2-1.mem 作为临时背景，写入后不再需要任何其他 L2_node.mem。

因此，L2-1、L2-2 等同层具体节点之间不会互相覆盖；每个 L2_node 都只持久化自己的 Records、自己的 mem revision、自己的 abs revision 和来源。

---

## 3. L1_node.mem 的两个产生入口

### 3.1 监控 DSH 的 context compact

comem 在根上下文观察 DSH Session/event 中的原生 compaction 生命周期：

~~~text
compaction/start
    ↓
compaction/summary
    ↓
带 surfaceOp=replace 的 user/message checkpoint
    ↓
compaction/end
    ↓
配对完成后创建 L1_node.mem
~~~

DSH 的实现顺序决定结算时机：

1. compaction/summary 是 log-only 事件；
2. 后续 user/message 才是改变 Session surface 的 checkpoint；
3. summary 到达时不能假定 replacement 已经落地；
4. comem 按 compactionId 配对 summary、checkpoint 和 end；
5. 配对成功后，把这次 compact 的结果写入新的 L1_node.mem；
6. summarySeq、checkpointSeq、shadowedSeqs、provider、model 和 usage 是来源元数据，不是 L1_node.abs。

comem 不调用 ctx.compaction.compactRegion()，也不调用 compactNow()。DSH 原生 provider 负责 context compact，comem 只监控其完成结果并创建 L1_node。

如果 native compact 失败、被取消或没有形成有效 summary，则不创建 L1_node.mem；保留 pending/failed 来源记录，供恢复或诊断。

### 3.2 Session 归档时的 archive compact

归档是第二个 L1_node.mem 入口：

~~~text
Session archive
    ↓
读取该 Session 当前可用的 surface/material
    ↓
comem 使用 ctx.llm 自己执行 archive compact
    ↓
创建新的 L1_node
└── L1_node.mem = archive compact result
~~~

archive compact 与 context compact 在节点语义上完全相同，区别只在 source.kind。archive compact 不是只生成 abs，也不是复制已有 L1_node.abs。

构造 archive compact 的素材时：

- 优先按当前 surface.nodes 的顺序读取可见内容；
- 使用 deriveEventMessage 构造实际模型消息；
- 不把 compaction/summary payload 与已经进入 surface 的 framed checkpoint 无条件重复拼接；
- 已发生过的 native compact 是当前可见素材的一部分，但 archive compact 仍然是一次独立 compact；
- Session 未加载或读取失败时保持 pending，不伪造 L1_node.mem。

### 3.3 两个入口进入 L2 层后的共同流程

~~~text
context compact ─┐
                 ├── compact result → L1_node.mem
archive compact ─┘
                              ↓
确定当前 active L2_node 的一次性背景：
  - L2_node.Records 非空：replay(L2_node.Records, order)
  - L2_node.Records 为空且上一个 L2_node 已满层：读取上一个 L2_node.mem 一次
  - L2_node.Records 为空且没有上一个 L2_node：empty
                              ↓
compact(background = 临时背景,
        target = L1_node.mem)
                              ↓
              只针对 L1_node 的 Record
                              ↓
              持久化 Record 到 L2_node.Records 和对应的 L2_node→L1_node edge
                              ↓
              丢弃临时背景；若本次使用了上一个 L2_node.mem，后续不再读取它
                              ↓
              生成 L1_node.abs
~~~

一次独立 compact 对应一个新的具体 L1_node。多个具体 L1_node 可以来自同一个 Session，也可以来自不同 Session；它们按 workspace 子树和产生顺序进入当前 active L2_node。

初始 active L2_node 的第一个 Record 使用空 background。L2 层轮换后新建的 active L2_node 也从空的 Records 开始，但第一个 Record 必须临时使用前一个已完成 L2_node.mem；该 Record 持久化后，当前 L2_node 的后续 Record 只使用当前 L2_node.Records。

---

## 4. L1_node 进入 L2_node 的三步

这是实现必须首先固定的流程。这里的 L1→L2 是层关系，L1_node 和 L2_node 是参与操作的节点。

### 4.1 第一步：创建 L1_node.mem

compact 成功后，先写不可变的 mem revision：

~~~text
C = compact result
L1_node = createNode(layer=L1)
L1_node.mem = C
persist(L1_node.mem)
~~~

先落盘 L1_node.mem，再执行父层追加、edge 和 abs。这样进程在后续任一步骤崩溃时，已经产生的 compact 仍然存在，只需要继续处理 pending 状态。

L1_node.mem 的 provenance 至少包含：

- sessionId；
- compactionId，或 archive compact 的 comemCallId；
- context compact 的 summarySeq、checkpointSeq、endSeq（若有）；
- shadowedSeqs 与 coverage（若有）；
- provider、model、usage；
- source.kind；
- 创建时间和格式版本。

### 4.2 第二步：确定临时背景并生成 Record

在 workspace 子树中找到当前 active L2_node。背景选择必须区分当前 L2_node 是否已经有 Record，以及它是否是在上一具体 L2_node 满层后新建的：

~~~text
if L2_node.Records is not empty:
    appendBackground = replay(L2_node.Records, order)
    backgroundSource = current L2_node.Records
else if previous completed L2_node.mem exists:
    appendBackground = previous completed L2_node.mem
    backgroundSource = one-time rollover background
else:
    appendBackground = empty
    backgroundSource = initial empty background

Record = compact(
  background = appendBackground,
  target = L1_node.mem,
  instruction = “在已有 L2_node 的基础上追加压缩；
                 过去的 L2_node 内容不受影响；
                 只输出 L1_node.mem 的压缩内容”
)

persist(Record)
persist(edge(L2_node, L1_node, order))
丢弃 appendBackground
~~~

当背景来自上一个已完成的 L2_node.mem 时，只把该 mem 读入本次模型调用。Record 写入当前 L2_node.Records 后，backgroundSource 不再参与后续追加；下一个 L1_node 只使用当前 L2_node.Records 的 replay 结果。不能把上一个 L2_node.mem 复制到当前 L2_node 的 Records、mem 或其他持续状态中。

Record 的输出只描述当前 L1_node.mem，不返回完整 L2_node，也不把 rollover background 当作输出目标。

如果 append compact 失败，则保留 L1_node.mem，不向 L2_node 写入不完整的 Record，等待重试；不能用 L1_node.abs 或空字符串代替 Record。若失败发生在 rollover background 调用中，仍然不改变当前 L2_node.Records。

### 4.3 第三步：生成 L1_node.abs

L1_node.mem 和只描述 L1_node.mem 的 Record 都已经持久化后，生成 L1_node.abs：

~~~text
L1_node.mem
+ L1_node 在 L2_node 中的 Record
+ L2_node 的当前信息（只作为背景）
    ↓
生成只针对 L1_node 的默认摘要
    ↓
L1_node.abs
~~~

L2_node 的信息包括 child 顺序、L2_node.Records、L2_node 的层级位置和已形成的 L2_node.mem（如果 L2 层已完成满层 compact）。如果当前 L2_node 已经有 Record，生成 abs 不需要读取其他 L2_node.mem；如果这是满层后新 L2_node 的第一个 Record，只有对应的 rollover background 调用可以读取上一个 L2_node.mem。L2_node 是背景，不应被模型写成 L1_node 的事实。

如果 abs 失败，L1_node.mem、Record 和 L2_node→L1_node 的 edge 都保留；只把 L1_node.abs 标记为 pending 或 failed，后续可以单独重试。

### 4.4 L2 层达到容量后的结算与轮换

每次追加后检查当前 active L2_node 的 Records 重放结果或 token 总量：

~~~text
if tokens(replay(L2_node.Records, order)) <= 102,400:
    L2_node 继续作为 L2 层的 active L2_node
else:
    L2_compactInput = replay(L2_node.Records, order)
    compact(L2_compactInput)
    L2_node.mem = compact result
    L2_node sealed/final

    create next active L2_node
    nextL2_node.Records = []
    nextL2_node 没有初始材料
    nextL2_node 的第一个 Record 到来时，
      一次性把已完成 L2_node.mem 作为 rollover background
    该 Record 写入 nextL2_node.Records 后，
      后续 Record 只 replay(nextL2_node.Records)
~~~

这里的满层 compact 结果写入触发满层的当前 L2_node.mem，不创建新的 L3_node.mem。上一个 L2_node.mem 只在下一个 L2_node 的第一个 Record 中作为临时背景使用；它不成为下一个 L2_node 的初始字段，也不在后续 Record 中继续读取。

上一个 L2_node 完成后仍作为一个完整的 L2 层节点进入 L3 层；在 L3 层的 Record 生成中，它的 mem 是 L3_node 的 target，而不是新 L2_node 的持续背景。

---

## 5. L2 层进入 L3 层：完全类推

L3 层与 L2 层的关系，完全复用 L2 层与 L1 层的关系。这里的 L2→L3 是层关系，具体参与操作的是一个完成的 L2_node 和一个 active L3_node。

### 5.1 L2_node→L3_node 的追加规则

新建 active L3_node 时，L3_node.Records 为空。若这是该子树的第一个 L3_node，则第一个完成的 L2_node 使用 empty background；若上一个 L3_node 已满层并写入 mem 后创建了新的 L3_node，则新 L3_node 的第一个 Record 临时使用上一个 L3_node.mem。这个上一 L3_node.mem 只用于该第一个 Record，Record 写入后不再读取任何其他 L3_node.mem。

~~~text
if L3_node.Records is not empty:
    appendBackground = replay(L3_node.Records, order)
else if previous completed L3_node.mem exists:
    appendBackground = previous completed L3_node.mem
    mark this as one-time rollover background
else:
    appendBackground = empty

L2_node.mem = 新 L2_node 的唯一 target

Record = compact(
  background = appendBackground,
  target = L2_node.mem,
  instruction = “在已有 L3_node 内容的基础上追加压缩；
                 过去的 L3_node 内容不受影响；
                 只输出 L2_node.mem 的压缩内容”
)

持久化 Record 到 L3_node.Records
持久化 L3_node→L2_node 的 child edge（order）
丢弃 appendBackground；后续只使用当前 L3_node.Records
~~~

appendBackground 只在本次 L2_node→L3_node append compact 调用期间存在。完成追加后，根据 L2_node.mem、L2_node 的 Record 和 L3_node 的背景信息生成 L2_node.abs。输出仍然只属于 L2_node，不重写 L3_node 的旧内容。

### 5.2 L3 层达到容量后的结算与轮换

~~~text
L3_compactInput = replay(L3_node.Records, order)
    ↓ 达到约 100K
compact(L3_compactInput)
    ↓
写入同一个 L3_node.mem
    ↓
L3_node 完成并创建下一个 active L3_node
    ↓
下一个 L2_node 到来时，其第一个 Record 必须临时使用上一个 L3_node.mem
    ↓
该 Record 写入后，后续只 replay(当前 L3_node.Records)
~~~

因此：

- L2 层满产生 L2_node.mem，不直接产生 L3_node.mem；
- L3 层满产生 L3_node.mem，不直接产生 L4_node.mem；
- L3 层与 L2 层之间的规则，与 L2 层与 L1 层之间的规则相同；初始父层节点的首个 Record 使用空背景，满层轮换后新父层节点的首个 Record 使用前一同层节点.mem 一次；
- 一个 L3_node 写入第一个 Record 后，后续只使用自己的 L3_node.Records，不再读取其他 L3_node.mem；
- abs 始终属于产生它的节点，不能用 L2_node.abs 代替 L2_node.mem 作为 L3_node 的追加 target；
- 在 L1_node→L2_node 或 L2_node→L3_node 的追加中，父层节点的既有 Records 不会被子节点的追加压缩覆盖；新内容只增加新的 Record。

### 5.3 L1_node/L2_node 与 L2_node/L3_node 的递归不变式

初始 L2_node 的第一个 L1_node 使用空 background；满层后的新 L2_node 的第一个 L1_node 使用上一个 L2_node.mem 一次：

~~~text
L2_node.Records 非空
    → replay(L2_node.Records) = appendBackground
L2_node.Records 为空且存在上一个完成的 L2_node.mem
    → appendBackground = 上一个 L2_node.mem（仅当前 Record）
L2_node.Records 为空且不存在上一个 L2_node
    → appendBackground = empty

appendBackground + L1_node.mem（唯一 target）
    ↓
Record = 只描述 L1_node.mem 的压缩内容
    ↓
持久化 Record 到 L2_node.Records 和 L2_node→L1_node edge
    ↓ L2 层达到约 100K
L2_compactInput = replay(L2_node.Records, order)
    ↓
compact(L2_compactInput)
    ↓
结果写回 L2_node.mem
    ↓
L2_node 作为完整的 L2 层节点进入 L3 层
~~~

L2_node 进入 L3_node 时完全相同：初始 L3_node 的第一个 L2_node 使用空 background；满层后新建的 L3_node 的第一个 L2_node 使用上一个 L3_node.mem 一次：

~~~text
L3_node.Records 非空
    → replay(L3_node.Records) = appendBackground
L3_node.Records 为空且存在上一个完成的 L3_node.mem
    → appendBackground = 上一个 L3_node.mem（仅当前 Record）
L3_node.Records 为空且不存在上一个 L3_node
    → appendBackground = empty

appendBackground + L2_node.mem（唯一 target）
    ↓
Record = 只描述 L2_node.mem 的压缩内容
    ↓
持久化 Record 到 L3_node.Records 和 L3_node→L2_node edge
    ↓ L3 层达到约 100K
L3_compactInput = replay(L3_node.Records, order)
    ↓
compact(L3_compactInput)
    ↓
结果写回 L3_node.mem
    ↓
L3_node 作为完整的 L3 层节点进入 L4 层
~~~

因此，更高层只需把上述 L1_node/L2_node、L2_node/L3_node 的角色整体上移；层名始终使用 L1、L2、L3，节点名始终使用 L1_node、L2_node、L3_node 或具体的 L1-X、L2-X、L3-X。
在任意一次追加中，父层节点已有的 Records 只作为背景；满层轮换后的新父层节点首个 Record 必须临时读取前一同层节点.mem，新输出只属于当前子节点，不覆盖父层节点已经持久化的 Records。

---

## 6. mem、abs 与默认读取

### 6.1 两种读取视图

OptMem 的长记忆衰减思想在 comem 中对应两个读取视图：

~~~text
默认读取：L1_node.abs / L2_node.abs / L3_node.abs
明确要求细节：L1_node.mem / L2_node.mem / L3_node.mem
~~~

- mem 是详细 compact，长期保存；
- abs 是同一个节点的默认摘要，不是另一个节点，也不是下一层；
- L2_node.abs 是 L2_node 的默认视图，展开时可读取 L2_node.mem、Records 和 children；需要层级 compact 输入时再按 order replay Records；
- L1_node.abs 是 L1_node 的默认视图，展开时可读取 L1_node.mem 和原始来源；
- 默认展示 abs 不代表删除 mem、Record 或 raw source。

### 6.2 展开路径

~~~text
L3_node.abs
  ↓ comem_open(expand)
L3_node.mem 或按 order replay(L3_node.Records)
  ↓ 沿 L3_node→L2_node edge 展开
L2_node.abs
  ↓ comem_open(expand)
L2_node.mem 或按 order replay(L2_node.Records)
  ↓ 沿 L2_node→L1_node edge 展开
L1_node.abs
  ↓ comem_open(expand)
L1_node.mem
  ↓
原始 Session 或 native compact 来源
~~~

abs 尚未生成时，工具必须返回 pending，不能把 mem 假装成 abs。改变默认读取预算只需要改变返回哪一个节点的 abs，以及是否允许继续展开，不需要重写 mem。

### 6.3 abs revision

新的 L1_node 或 L2_node 进入对应的 L2_node 或 L3_node 后生成对应的 abs。因模型、树背景或展示策略需要重新生成时，可以写同一节点的新 abs revision：

~~~text
同一个 L1_node
├── 一个或多个不可变 mem revision
├── abs revision 1
└── abs revision 2（可选重新摘要）
~~~

重新生成 abs 不创建新的 L1_node，也不改变对应的 L1_node.mem。L2_node.mem 和更高层节点的 mem 也遵循同一原则。

---

## 7. 与 DSH compaction 的关系

### 7.1 DSH event 语义

DSH compaction seam 的事实是：

- compaction/summary 是 log-only 结果记录；
- 后续 user/message 携带 framed checkpoint 并执行 surface replace；
- shadowedSeqs 是真正被替换的 surface 节点集合；
- shadowedRange 是位置边界，不应当当作连续数值区间；
- summarySeq 与 checkpoint user/message seq 必须分开保存。

这些字段用于判断 context compact 是否完整、建立 L1_node.mem 的 provenance，并支持按需回溯。它们不改变 comem 的业务规则：完成的一次 compact 就产生一个新的 L1_node.mem。

一次 native compact 可能只覆盖当前 surface 的一部分，因为 DSH 会保留近期 tail。这个事实应记录在 coverage 中，但不能把 L1_node.mem 错误地描述为整个 Session 的唯一完整摘要。

### 7.2 Basic provider 的格式边界

dsh-compaction-basic 的八段 Markdown、compacted-summary 标签和 prior checkpoint 合并规则是 Basic provider 的提示词与 framing，不是 compaction seam 对所有 provider 的硬契约。

因此：

- L1_node.mem 保存实际 compact 返回的 ContentBlock 和 source format；
- L1_node.abs 使用 comem 自己的摘要契约；
- 不要求其他 compaction provider 也输出八段；
- 如果当前 provider 是 Basic，可以识别其格式，但不能把 Basic 私有格式写成 mem/abs 的通用不变式。

### 7.3 跨 Session 的 L1→L2 追加

如果 L2 层要接收来自不同 Session 的多个具体 L1_node，仍然逐个执行背景压缩后追加。跨 Session 不改变 L2_node 的轮换规则：

~~~text
if L2_node.Records is not empty:
    appendBackground = replay(L2_node.Records, order)
else if previous completed L2_node.mem exists:
    appendBackground = previous completed L2_node.mem
    mark this as one-time rollover background
else:
    appendBackground = empty

L1_node.mem = 当前 target

Record = compact(
  background = appendBackground,
  target = L1_node.mem,
  instruction = “只输出当前 L1_node.mem 的压缩内容；不改写旧 L2_node 内容”
)

持久化 Record 到 L2_node.Records 和对应 child edge
丢弃 appendBackground；当前 L2_node 有 Record 后不再读取其他 L2_node.mem
~~~

所有具体 L1_node 的 Record 按产生顺序持久化到同一个 L2_node。只有按 order 重放这些 Records 得到的 L2_compactInput 达到约 100K 时，才执行 L2 层整体 compact，并将结果写入 L2_node.mem。L2-1 满层后，L2-2 的第一个 Record 必须使用 L2-1.mem 一次；L2-2 后续 Record 不需要 L2-1.mem。

这不是 native compactRegion，因为 DSH 原生 compact 只能操作一个 Agent 对应的单一 Session surface。跨 Session 的追加和层级 compact 都由 comem 使用 ctx.llm，但输出仍遵守“背景用于防止失真，输出只属于当前 target”的规则。

---

## 8. 预算、分批与模型

### 8.1 L2 层的逻辑满层

L2 层不会等到 100K 才第一次处理 L1_node。每个新 L1_node 到来时，立即执行一次；背景按当前 active L2_node 的状态选择：

~~~text
if L2_node.Records is not empty:
    appendBackground = replay(L2_node.Records, order)
else if previous completed L2_node.mem exists:
    appendBackground = previous completed L2_node.mem
    mark this as one-time rollover background
else:
    appendBackground = empty

Record = compact(
  background = appendBackground,
  target = L1_node.mem,
  instruction = “在已有 L2_node 的基础上追加压缩；
                 过去的内容不受影响；只输出 L1_node.mem 的压缩内容”
)
持久化 Record 到 L2_node.Records 和对应 child edge
丢弃 appendBackground
~~~

每个 Record 只属于一个具体 L1_node。L2_node 已有的 Records 保持原样，不被本次模型输出重写或复制。若本次是满层轮换后新 L2_node 的第一个 Record，appendBackground 必须是上一个 L2_node.mem；该 Record 写入后，后续只 replay 当前 L2_node.Records。

当按 order replay(L2_node.Records) 得到的 L2_compactInput 达到约 100K 时：

~~~text
compact(L2_compactInput)
    ↓
L2_node.mem = 满层 compact result
    ↓
L2_node sealed；创建下一个 active L2_node
    ↓
下一个 L2_node 的第一个 Record 临时使用本 L2_node.mem
~~~

满层 compact 的输出属于 L2_node 本身，不是新的 L3_node.mem。L2_node 完成后才作为具体节点进入 L3 层。

### 8.2 physical call budget 不足

逻辑满层与物理窗口是两件事：

- logical layer cap 约为 100K；
- 一次 append compact 需要同时携带当前 L2_node.Records 重放得到的背景或轮换时的前一 L2_node.mem，以及 child node.mem；
- 一次满层 compact 需要携带当前 L2_node 已经积累的 Records；
- 超过 physical call budget 时，按 child node 或 child node 内的安全边界分批；
- append compact 的分批结果仍合并为同一个 Record，并且只描述同一个 child node；
- 满层 compact 的分批结果仍合并为当前层自己的一个 mem；
- 不能把批次变成新的 L1_node、L2_node 或更高层节点；
- 单个不可拆分的超大 child node 进入 pending/failed，不静默截断。

---

### 8.2 physical call budget 不足

逻辑满层与物理窗口是两件事：

- logical layer cap 约为 100K；
- 一次 append compact 需要同时携带 parent node 的背景和 child node.mem；
- 一次满层 compact 需要携带当前层已经积累的 Record；
- 超过 physical call budget 时，按 child node 或 child node 内的安全边界分批；
- append compact 的分批结果仍合并为同一个 Record，并且只描述同一个 child node；
- 满层 compact 的分批结果仍合并为当前层自己的一个 mem；
- 不能把批次变成新的 L1_node、L2_node 或更高层节点；
- 单个不可拆分的超大 child node 进入 pending/failed，不静默截断。

### 8.3 route 与 provenance

append compact、满层 compact 和 abs 调用使用 comem 选定的 route，并记录 provider、model、usage、promptVersion 和 formatVersion。默认尽量跟随产生对应 mem 的会话 route；没有可用 route 时使用 Config fallback；没有可用模型时保持 pending。

历史节点需要保存当时的 logical cap、physical budget、route、token estimator、prompt version 和 format version。Record 还要保存 parent node 当时已包含的 Record order 或 background digest 和 child node mem revision。

---

## 9. 持久化与 schema

### 9.1 必须持久化的关系

存储必须能重建：

~~~text
一次独立 compact
  → 一个 L1_node.mem 或某一层具体节点自己的 mem
  → source/provenance

一个 child node 进入 parent L2_node/L3_node
  → 如果当前 parent node 有 Records，按 order replay 当前 parent node.Records
  → 如果当前 parent node 没有 Record 且存在前一同层已完成节点，临时读取前一节点.mem 一次
  → 如果不存在前一同层节点，使用 empty background
  → 以临时背景执行 child-specific compact
  → 只描述 child node 的 Record
  → 带顺序的 parent-child edge
  → 按 order 持久化 parent L2_node/L3_node 的 Record
  → 当前 parent node 写入 Record 后，不再读取前一同层节点.mem

某一层达到容量
  → 按 order replay 该层具体节点的 Records，生成该层的 compactInput
  → 对 compactInput 执行 compact
  → 结果写入该具体节点自己的 mem
  → 创建下一个 active 同层节点
  → 下一个同层节点的第一个 Record 必须临时使用本节点.mem
  → 该 Record 写入后，后续只 replay 新节点自己的 Records
  → 该具体节点进入更高层

任意具体节点
  → 当前 mem revision
  → 当前 abs revision
~~~

Record 是父层保留新内容的关键记录。它必须保存 child node、child node mem revision、parent L2_node/L3_node 当时已包含的 Record order 或 background digest；如果它是满层轮换后新节点的第一个 Record，还要保存前一同层节点的 backgroundMemRef。Record 的输出只描述 child node，父层已经持久化的 Records 不能依靠下一次模型输出重建。

### 9.2 落盘方案

采用方案 A，Comem 强制通过 `ctx.storageDomain` 使用 DSH_HOME 下的 `comem` 存储域；DSH 默认 JSON backend 的记录路径为 `$DSH_HOME/storages/comem/events/`。runtime 必须在创建 engine 前成功打开该 domain；如果 `storageDomain` 服务不存在、打开失败或返回不可用 domain，插件创建失败并停止，不使用任何文件 fallback。逻辑记录至少包括：

- nodes：节点元数据、所属 layer、children、active/sealed 状态；
- mem revisions：每次独立 compact 产生的节点 mem；
- Record revisions：child node 进入 parent node 时产生的只描述 child node 的追加压缩内容；
- abs revisions：每个节点的摘要；
- heads：每个 workspace 子树各层的 active 节点和 pending 队列；
- edges：父子关系、顺序和 child revision。

一次 child append 的持久化顺序是：先写 child node.mem，再确定一次性背景，再写 Record，再写 parent-child edge，最后根据 Records 的 token 总量或 replay 结果更新容量估算。若 parent L2_node/L3_node 因本次追加而满，再写该节点自己的 layer mem revision，创建下一个 active 同层节点；下一节点的第一个 Record 才可以一次性读取这个 mem。

Comem 的逻辑记录要求保持可追加、可重放、可追溯；物理持久化完全由 DSH `storageDomain` 的后端负责。当前 per-record JSON backend 会将 `comem/events` 表中的记录分别保存为文档，不把普通 JSON 文档称为 JSONL。无论后端怎样实现，mem、Record、edge 和来源记录都必须具备 append-only 的恢复能力。

### 9.3 schema 草案

不需要保存可变的大文本。active L2_node/L3_node 新建时 Records 为空；Records 按 order 重放得到的临时输入在 append 或层满 compact 调用结束后丢弃。该层达到容量后产生的 ComemMemRevision 另行保存，这样既能重建当前节点，又不会把临时层材料误当成节点字段。

### 9.4 并发与恢复

一次 L1_node→L2_node 结算的顺序固定为：

1. 持久化新的 L1_node.mem；
2. 如果 active L2_node.Records 非空，按 order replay 作为 appendBackground；
3. 如果 active L2_node.Records 为空且它是在上一个 L2_node 满层后新建的，临时读取上一个 L2_node.mem；否则在子树的第一个 L2_node 使用 empty background；
4. 调用 comem 自己的 ctx.llm，生成只描述 L1_node.mem 的 Record；
5. 持久化 Record 和对应的 L2_node→L1_node edge；
6. 丢弃 appendBackground；当前 L2_node 有 Record 后，后续不再读取上一个或其他 L2_node.mem；
7. 按 Records 的 token 总量或 replay 结果更新 L2 层容量估算；
8. 若 L2 层满，压缩按 order replay 当前 L2_node.Records 得到的 L2_compactInput，并持久化当前 L2_node.mem；
9. 生成 L1_node.abs。

如果进程在第 3～5 步退出，恢复逻辑通过同一 workspace 子树中同层节点的 order 找到前一个已完成节点；只有当前 L2_node 还没有 Record 时，才重新读取前一个 L2_node.mem。Record 落盘后，恢复逻辑不再把前一个 L2_node.mem 作为当前 L2_node 的背景。若 Record 已落盘但 edge 尚未落盘，按 Record 的 parent、child、order 幂等补写 edge。

L2_node 完成后进入 L3 层时，把上面流程中的 L1_node/L2_node 整体替换为 L2_node/L3_node，使用同一顺序：新建的 L3_node 首个 Record 必须一次性使用前一个 L3_node.mem，之后只使用当前 L3_node.Records。

- 同一个 compactionId 或 archive callId 幂等，重复事件不重复创建 L1_node；
- 同一个 parent node、child node 和 order 只允许一个 Record；
- Record、edge 和 mem revision 都必须可从 append-only 记录重放；
- 同一 workspace 子树的 active parent node 追加操作串行化；
- summary 到 replacement 之间退出时，保留 observation pending，启动后继续配对；
- L2 层满层 compact 失败时保留 L2_node 的 children、Records 和已产生的 mem revision，L2_node.mem 标记 pending/failed；
- abs 失败只影响 abs，不回滚 mem、Record 或父子关系。

---

## 10. 工具、读取与 shared

### 10.1 工具

~~~text
comem_search(query, scope?)
comem_open(node_id?, mode?)
comem_note(content)
~~~

### 10.2 默认读取

comem_open 默认读取节点的 abs，并返回必要的 child index：

- default：返回具体节点的 abs；
- expand：返回具体节点的 mem、Records、children 和来源摘要；需要层级 compact 输入时按 order 临时 replay Records；
- source：返回 compact provenance、coverage 和原始 Session 引用；
- 输出标注 nodeId、revision、contentType=mem 或 abs；
- abs 尚未生成时明确返回 pending，不把 mem 假装成 abs。

comem_search 默认搜索 abs；模型明确要求细节时，再搜索或打开 mem。这样实现旧内容默认显示摘要、要求时展开详细记忆，但不物理删除任何来源。

### 10.3 shared

shared 子树只由 comem_note 写入：

- 用户偏好、机器环境和跨 workspace 通用结论可以写入；
- workspace 内的 L1_node.mem、L2_node.mem 或更高层节点内容不自动流入 shared；
- shared 的 note 记录可以使用同一套 node/abs 读取接口，但 source.kind 标记为 note，不伪装成 Session compact。

提示词由插件通过 ctx.systemPrompt.section() 注册，至少说明默认返回 abs、需要细节时使用 expand，以及 comem_note 的适用范围。不做 shared 自动注入。

---

## 11. 成本、质量与失败

### 11.1 调用分类

需要分别统计：

1. DSH 已经执行的 native context compact；
2. 归档时 comem 执行的 archive compact，用于产生 L1_node.mem；
3. 每个 L1_node 进入 L2_node 时的 child-specific append compact；
4. 为新 L1_node 生成 L1_node.abs 的调用；
5. L2 层达到约 100K 后生成 L2_node.mem 的满层 compact；
6. 完成的 L2_node 进入 L3 层时生成只描述 L2_node.mem 的 append compact 和 L2_node.abs；
7. 更高层的同类 append、满层 compact、abs、分批、失败重试和模型溢出恢复调用。

第 3 类调用是每个 L1_node→L2_node 追加的核心成本，不能只统计 L2 层满后的 compact。同理，L2_node→L3_node 也不是直接拼接，而是先以 L3_node 为背景压缩 L2_node.mem，只把 L2_node 的追加段写入 L3_node。

3.7K 是本机 DSH native summary 的历史统计，不是任何具体节点的 mem、abs 或 Record 的硬长度，也不能据此推出固定分支因子。

### 11.2 mem 与 Record 校验

mem 的验证关注：

- compact 是否完整结束；
- native summary、checkpoint replacement、end 是否正确配对（若来自 DSH）；
- source coverage、shadowedSeqs 和 childRevisions 是否可追溯；
- 输出是否为空、截断或失败；
- provider、model、usage 是否保存；
- 对 L2 层及以上，满层 compact 的结果是否确实写回当前具体节点的 mem，而不是误建成更高层节点的 mem。

Record 的验证关注：

- backgroundRecordOrder/backgroundDigest 对应追加前 parent L2_node/L3_node 已包含的 Records；轮换首个 Record 使用前一同层节点.mem 时，backgroundMemRef 必须指向该节点的 mem revision；
- 当前 L2_node/L3_node 已有 Record 后，后续 Record 不得再读取其他同层节点.mem；
- target 是唯一对应的 child node.mem；
- 输出只描述 child node.mem，不复制或重写 parent node 的既有内容；
- Record、child edge 和 order 一一对应；
- 重试不会再次追加同一个 parent node、child node 和 order；
- 追加后 parent L2_node/L3_node 的层级 compact 输入可以由 Records 按 order 重放得到。

### 11.3 abs 校验

abs 的验证关注：

- 目标是否是刚进入 parent node 的那个 child node；
- 是否使用了对应的 source mem revision 和 Record；
- parent node 信息是否只作为上下文，而没有被错误写成 child node 的事实；
- 输出是否为空、截断或没有进展；
- 是否保存 parent context 和调用 provenance。

失败时：

- mem 已产生就不能因为 append 或 abs 失败而删除；
- append compact 失败时保留 child node.mem，parent node 不写入不完整的 Record，等待重试；
- Record 和 child edge 已落盘后，不能因为 abs 失败而撤销；
- L2_node 的满层 compact 失败时保留 L2_node 的 children、Records 和已产生的 mem revision，等待重试；
- 所有 raw output 和失败原因都应在可重放记录中保存。

---

## 12. 风险与最低验收

| 风险 | 处理 |
|---|---|
| 把 L1、L2 层标签误当成节点 | 代码和文档只用 L1_node/L2_node 或 L1-X/L2-X 表示节点 |
| 把 abs 当成另一个节点 | schema 中 memRevision 与 absRevision 分开 |
| 把一次 compact 覆盖旧的 L1_node.mem | 每次独立 compact 创建新的 L1_node，按 compactionId 幂等 |
| summary 早于 checkpoint replacement | 按 compactionId 等到完整事务再创建 L1_node |
| 归档重复通知 | archive callId 幂等 |
| 追加时模型重写旧 parent node | parent node 的旧内容只作为 background；Record 只允许描述 child node |
| 同层节点轮换时持续依赖前一节点 mem | 前一同层节点.mem 只允许作为新节点第一个 Record 的临时 background，Record 写入后立即停止读取 |
| Record 与 child edge 不一致 | 两者使用同一 child node、mem revision 和 order |
| Record 重复写入 | parent node、child node、order 和 callId 幂等 |
| L2 层满后错误创建 L3_node.mem | compact 结果先写入当前 L2_node.mem，完成的 L2_node 再进入 L3 层 |
| child node 顺序丢失 | Record 和 edge 都带 order，可重放 |
| append/abs 失败导致 mem 丢失 | mem、append、edge、abs 分阶段持久化 |
| 物理窗口不足 | 按 child node 边界分批，最后仍合并为当前层具体节点自己的 mem |
| 默认摘要被误认为原文删除 | mem、append history 和 source 永久保留，expand 才读取 |
| Basic 八段格式被当成通用契约 | 按 provider 识别；abs 使用独立校验 |
| logical cap 被误当模型 attention | 分开记录 logical cap 与 physical budget |
| L2→L3 另写一套算法 | 只实现 L1→L2，L3 及以上参数化复用 |

最低验收用例：

1. native context compact 完成后创建一个新的 L1_node.mem；
2. archive 触发 comem compact，并创建一个新的 L1_node.mem；
3. 同一个 Session 的两次不同 compact 创建两个不同的具体 L1_node；
4. L1-1、L1-2 按顺序进入同一个未满的 L2-1；
5. L1-2 进入 L2-1 时，模型以按 order replay(L2-1.Records) 得到的临时背景为上下文，但输出只包含 L1-2.mem 的追加压缩内容；
6. 追加 L1-2 后，L2-1 在接收 L1-2 前已经积累的内容保持不变，末尾只增加对应 Record；
7. L2-1 能准确持有 L1-1、L1-2 的 child edge 和 Record；
8. L2-1 达到约 100K 后，compact 结果写入 L2-1.mem，而不是创建 L3_node.mem；
9. 完成的 L2-1 进入 L3 层时，以 L3_node 为背景压缩 L2-1.mem，只追加 L2-1 的内容；
10. 新 child node 进入 parent node 后生成对应 child node.abs；
11. append 或 abs 失败时 mem、append history 和父子关系仍然存在；
12. 默认工具读取具体节点的 abs，expand 才读取该节点的 mem；
13. summary 在 replacement 前到达时仍能正确配对；
14. 重复 compact/archive/append 事件不会重复创建具体 L1_node 或追加内容；
15. native compact、archive compact、具体节点 mem、Record、具体节点 abs 的 provenance 可以分别追溯。
16. L2-1 达到约 100K 后写入 L2-1.mem，创建 L2-2；L2-2 的第一个 Record 临时使用 L2-1.mem；
17. L2-2 写入第一个 Record 后，第二个 Record 只 replay(L2-2.Records)，不再读取 L2-1.mem 或其他 L2_node.mem；
18. L2-2 达到约 100K 后，L2_compactInput 只由 L2-2.Records replay 得到，不重新读取 L2-1.mem；

---

实现顺序必须遵循层与节点的业务顺序：

~~~text
1. context/archive compact → 创建 L1_node.mem
2. 确定 active L2_node 的一次性背景：
   → 有 Records：replay(L2_node.Records)
   → 无 Record 且有前一已完成 L2_node：临时读取前一 L2_node.mem
   → 否则：empty
3. 只输出 L1_node 的 Record，并追加到 L2_node.Records
4. 持久化 L2_node→L1_node 的 child edge 和 Record
5. 丢弃一次性背景；当前 L2_node 有 Record 后不再读取其他 L2_node.mem
6. 根据 L1_node、Record、L2_node 信息生成 L1_node.abs
7. 按 order 重放 L2_node.Records 得到 L2_compactInput，达到约 100K
   → compact(L2_compactInput)
   → 把结果写入当前 L2_node.mem
8. 当前 L2_node 完成后创建下一个 active L2_node
   → 下一个 L2_node 的第一个 Record 临时使用当前 L2_node.mem
   → 后续只 replay 新 L2_node.Records
9. 完成的 L2_node 进入 L3 层
   → 复用第 2～8 步，只替换为 L3_node 的父层操作
~~~

L3 层及以上只复用上述状态机，把 child layer 和 parent layer 同时上移；节点名称始终使用 L1_node/L2_node/L3_node 或具体的 L1-X/L2-X/L3-X。

不要实现以下错误快捷路径：

- 用裸的 L1、L2、L3 表示节点；
- 最新 native summary 直接覆盖旧的具体 L1_node.mem；
- L2 层满后直接创建 L3_node.mem，跳过“写入当前 L2_node.mem，再把完成的 L2_node 交给 L3 层”。