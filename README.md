# dsh-java-dev

Java 高效开发插件（DeepSeek Harness 宿主插件，纯 ESM、零依赖、不调用模型）。

## 能力

| 工具 | 作用 |
| --- | --- |
| `java_apply` | 用「意图 + 参数」模板生成/扩展 Java 代码，省 token；一次可组合多个 op |
| `java_apply_list` | 列出可用模板 |
| `java_fix` | 对文件/目录做确定性修复（可 dry-run、可用 javac 校验），只返回摘要 |
| `java_env` | 探测 JDK / Gradle / Android SDK / FFmpeg / LWJGL(OpenGL) / IDEA 格式化器，并按项目解析该用哪一套 |

另外：**任何工具写入/编辑 `.java` 文件后会自动跑 safe 修复集**，并在工具结果里追加一行 `[java-autofix] ...`。系统提示词里也加入了使用指引，让模型优先走 `java_apply`。

## 自动修复（无需模型、只做唯一确定的修复）

safe 规则集：

1. 去重 import（`static` / 通配符形式也参与去重）
2. 删除未使用 import —— **只删普通类型 import**；`import static ...` 与 `import ...*;` 永不自动删除（无法用词法可靠判断），Javadoc 里 `{@link X}`、`@see X`、`@throws X` 的引用也算使用
3. 补缺失 import —— 仅限已知且唯一的 JDK/常见库全限定名；应用后用 javac 验证诊断数确实下降才保留
4. 补 `@Override` —— 仅限确定的重写：`toString/hashCode/equals/clone/finalize`，或显式 `implements Runnable/Callable/AutoCloseable/Comparable/Iterable/Comparator/CharSequence` 的对应方法
5. `Serializable` 类补 `serialVersionUID`（按类结构做稳定哈希）
6. import 分组排序（java → jakarta → javax → org → com → 其它 → static；静态导入放最后并单独分组）
7. 行尾/文件末尾换行规范化、`package` / import 块后空行、连续空行折叠

安全策略：只做唯一确定的编辑；补 import 前后跑 javac 对比错误数，引入新错误则回滚。单文件 >512KB、read-only 会话、工作区外的文件不处理。

## 极简意图（preset）—— 基础结构一键生成

`java_apply` 支持一个词描述整套结构，参数全部可选：

```json
{"path": "src/main/java/com/example/User.java", "intent": "pojo",
 "name": "User", "fields": [["Long", "id"], ["String", "name"]]}
```

内置 preset（32 个）：

| preset | 生成内容 |
| --- | --- |
| `pojo` | public 类 + private 字段 + getter/setter + equals/hashCode + toString（可选 builder/logger） |
| `immutable` | final 类 + final 字段 + 全参构造 + getter + equals/hashCode/toString |
| `record` | record（字段用 `[[type,name]]` 或 `"Type name"`），可选 builder/compactConstructor |
| `recordBuilder` | record + 流式 builder |
| `dto` | Serializable + 无参/全参构造 + getter/setter + equals/toString |
| `entity` | JPA：`@Entity/@Table/@Id/@GeneratedValue` + no-arg 构造 + 按 id 的 equals/hashCode |
| `service` | Spring `@Service` + 构造注入（`dependencies:[[Type,name]]`）+ SLF4J logger |
| `controller` | `@RestController/@RequestMapping` + 路由方法（`routes`） |
| `repository` | Spring Data `JpaRepository<Entity, ID>` 接口 |
| `test` | JUnit 5 `@Test` 测试类（`target`/`methods`） |
| `singleton` | 饿汉单例：INSTANCE + 私有构造 + getInstance |
| `exception` | RuntimeException 子类 + 三个标准构造 |
| `main` | 带 main 方法的类（`body`） |
| `enum` | 枚举 + 常量（`constants`）+ 可选字段/方法 |
| `interface` | 接口 + 方法声明（`methods`） |
| `annotation` | `@interface` + 元素（`members`） |
| `sealed` | sealed 类/接口 + permits（自动生成嵌套子类型，保证可编译） |
| `config` | Spring `@Configuration` + `@Bean` 方法 |
| `activity` | Android Activity + `onCreate` + `setContentView` |
| `util` | final 工具类 + 私有构造 + 静态方法 |
| `constant` | 常量类（`constants:[[type,name,value]]`）+ 私有构造 |

**高性能 / 渲染 / 计算专用 preset**（全部 JDK-only，生成即可编译）：

| preset | 生成内容 |
| --- | --- |
| `benchmark` | nanoTime 基准测试：预热 + blackhole + ns/op 输出（`body` 可替换被测逻辑） |
| `ringbuf` | SPSC 无锁环形队列：`Object[]` + `AtomicLong` + `lazySet` + 2 的幂容量 |
| `objectpool` | 对象池：`Supplier` 工厂 + `ArrayDeque` 复用 |
| `soa` | Struct-of-Arrays 容器：每个字段一个原始数组 + 扩容 + `add` + 裸数组访问器 |
| `mat4` | 4×4 float 矩阵：直接 `float[16]` 布局，identity/copy/multiply/transform |
| `gameloop` | 固定步长游戏/仿真主循环（累加器 + 插值 alpha + MAX_FRAME_TIME 钳制） |
| `framebuffer` | 软件渲染 RGBA 帧缓冲：`int[] pixels` + clear/set/get |
| `parallel` | 分块并行循环：`forEachChunked` / `sum`（ForkJoin 后端） |
| `arena` | 离堆线性分配器：direct `ByteBuffer` + 对齐分配 + reset（AutoCloseable） |
| `lwjgl` | LWJGL 3 + GLFW 窗口与渲染循环骨架（`window`/`render`/`main`） |
| `noise` | 确定性 value noise（置换表 + fade/lerp），用于程序化地形/纹理 |

也可以在 `ops` 里用 `{"intent": {"preset": "pojo", ...}}`，或只写 granular ops。

## 细粒度 op（需要精确控制时）

```json
{
  "path": "src/main/java/com/example/User.java",
  "ops": {
    "class": "public User",
    "fields": ["Long id", "String name"],
    "getters": {}, "setters": {}, "equalsHashCode": {}, "toString": {},
    "logger": {"framework": "jul"}
  }
}
```

可用 op：`class` / `interface` / `record` / `enum` / `annotation`（对象或极简字符串，如 `"User(long id, String name)"`、`"Color: RED,GREEN"`）、`fields`、`methods`、`constructors`、`getters`、`setters`、`builder`、`singleton`、`compactConstructor`、`equalsHashCode`、`toString`、`logger`（slf4j/jul/log4j2）、`javadoc`、`imports`、`annotations`、`main`。
新文件会自动从 `src/main/java` / `src/test/java` 推断 package（也可显式传 `package`）。

## 工具链探测

`java_env` 默认扫描 `D:/harness2`、`D:/`、`Program Files`、`Program Files (x86)`、`%LOCALAPPDATA%/Programs`，可通过配置 `toolRoots` 增加：

- 多 JDK（含嵌套目录的 GraalVM、toolchain）
- Gradle + `GRADLE_USER_HOME`
- Android SDK（`platform-tools/adb.exe` 必须存在；项目模式下优先 `local.properties` 的 `sdk.dir`）
- FFmpeg（含 `ffprobe`，读取 `-version`）
- LWJGL/OpenGL jar（按项目分组，主 jar 与 natives 分开）以及系统 `opengl32.dll`、Vulkan
- IntelliJ IDEA 及其 `bin/format.bat`（可用于后续格式化后端）

项目模式（不传 `which`）会给出「这个项目该用的」工具链：JDK 选择顺序为 `gradle.properties: org.gradle.java.home` → 21 → 17 → 非 GraalVM → 任意。

## 安装

```bash
# 通过插件管理器安装（绝对目录）
plugin_manager install_bundle  target=D:\插件\dsh-java-dev
```

或在 DSH 插件市场/设置里启用。首次安装或替换包后需要**重启 DeepSeek Harness** 才会加载新的 JS 模块（ESM 缓存）。

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: java-dev
      name: dsh-java-dev
      config:
        toolRoots: ["D:\\harness2", "D:\\"]
        autoFix: safe          # safe | all | off
        useIdeaFormatter: true  # 预留：IDEA format.bat
        cacheTtlMs: 300000
```

## 测试

```bash
cd D:\插件\dsh-java-dev
node --test test/core.test.js
```

58 个测试覆盖：Java 结构解析、文本编辑原语、8 条修复规则、15 个细粒度模板、32 个 preset（含高性能/渲染）、import 安全性、工具链探测；高性能 preset 生成物用真实 javac 编译验证。

## 目录

```
index.js                 插件入口（注册工具、自动修复钩子、系统提示词）
core/java-source.js      Java 结构解析（注释/字符串掩码 + 偏移不变）
core/edit.js             编辑原语与 import 操作
core/javac.js            javac 调用与诊断解析
core/env.js              工具链探测与项目级解析
core/fix/rules.js        修复规则 + SAFE_RULES
core/fix/engine.js       修复编排与校验
core/template/engine.js  模板引擎
tools/*.js               四个工具定义
test/core.test.js        测试
```
