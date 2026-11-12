export type DocumentationRisk='low'|'medium'|'high';
export interface RootDocumentation {title:string;summary:string;userTopic:string;risk?:DocumentationRisk}
function rows(text:string,topic:string):Record<string,RootDocumentation>{
    return Object.fromEntries(text.trim().split('\n').map(line=>{const[key,title,summary]=line.split('|');return[key,{title,summary,userTopic:topic}];}));
}
export const SETTINGS_DOCUMENTATION:Record<string,RootDocumentation>={
 ...rows(String.raw`apiProviders|远程模型服务|登记云端或兼容接口与聊天模型；先验证服务，再选模型，不把保存当作连接成功。
localLlmConfigs|本地模型服务|登记本机或局域网模型；需要已启动的服务，插件不会自动安装或下载模型。
localLlmConfig|旧单例本地模型|历史兼容入口，由新版列表接管；不要用它替换现有多模型配置。
localLlmVerified|旧本地验证状态|旧版连接结果，由受信检查维护，不能据此推断当前地址仍然可用。
localLlmAvailableModels|旧本地模型列表|旧版发现结果，仅用于兼容；实际可选模型以当前服务检查为准。
cliConfig|命令行模型|连接用户已有的 Agent CLI；检查可能启动程序，其费用与权限独立于内置 HTTP 账本。
systemPrompt|回答习惯|说明回答语言、深度和证据要求；文字随相应请求发送，不替代访问权限。
proxyUrl|网络代理|给支持的请求入口指定代理；为空沿用直连，修改后需按真实服务验证。
proxyBypass|代理例外|指定不经代理的目标；过宽的例外会改变出站路线，应按实际连接核对。
credentialStorage|凭据保存方式|选择插件文件或设备 SecretStorage；设备密钥不会随普通配置包迁移。
configuredCredentials|凭据状态|系统维护的安全存储状态或引用，不是读取明文密钥的入口。`,'first-setup'),
 ...rows(String.raw`readingMenus|阅读右键菜单|调整场景、动作、名称及顺序；原阅读、草稿和插入回调继续保留。
settingsAppearance|设置首页外观|管理首页介绍与帮助入口，只改变呈现，不改变模型和资料。
hideWorkspaceFolder|隐藏工作区目录|减少受管目录在文件列表中的干扰，已有目录和文件继续保留。
saveChatHistory|保存聊天历史|决定是否保留聊天记录；关闭会减少相应历史恢复能力。
maxSavedChatHistories|历史保留数量|限制聊天历史数量；保留越多占用越大，按实际使用量调整。
manualChatSaveFolder|聊天手动保存目录|手动导出的库内位置，宜选择希望长期保存的笔记目录。`,'customization'),
 ...rows(String.raw`storageLayout|目录布局|为产物选择继承或独立目录；改路径不会自动搬迁原文件。
workspaceFolder|工作区根目录|受管配置及产物的默认起点；修改前核对依赖并保留原目录。
skillsFolder|技能目录|可编辑 Skills 的存放位置；已有技能和引用不自动移动。
skillsFolderPath|有效技能位置|运行时解析的目录，由系统维护；调整应通过对应目录设置。`,'storage'),
 ...rows(String.raw`sourceWatch|原资料转换监听|按选定范围输出派生文本；与索引监听独立，开启可能产生转换任务。
knowledgeSources|可选知识来源|登记聊天可挂接的资料，缺失时定位原来源，不新建同名替代。
ragIndexIdleSeconds|编辑后等待|每篇笔记从最近的实际保存独立等待。默认 600 秒，支持 5–900 整数秒。修改后重算正在等待的笔记。
ragContinueAfterClose|关页后继续等待|默认开启。关掉最后一个笔记页签时，可以重新开始等待；关闭此选项后可选择立即更新或暂缓到重开。
jevRagFilterEnabled|模型辅助筛选|请辅助模型筛选检索结果，可能增加外部调用；先评估收益和费用。
jevApiKey|筛选服务凭据|辅助筛选认证，优先本地填写，普通读取不返回原值。
jevUseOpenRouter|筛选服务路线|选择 OpenRouter 筛选路线，需相应模型和费用配置。`,'retrieval'),
 ...rows(String.raw`requestControls|用量、预算与发送隐私|控制内置 HTTP 的预算和出站正文；CLI、MCP 与实时语音费用另计。
maxFunctionCalls|单轮工具次数|限制模型连续调用工具；过低可能中断任务，过高增加时间与费用。
functionCallWarningThreshold|工具次数提醒|在工具循环接近上限时提醒，不增加实际执行权限。
listNotesLimit|笔记列表上限|限制一次列出的笔记数，过大增加上下文；更多内容按范围或分页读取。
maxNoteChars|单次读取字符上限|长文返回截断和继续读取信息；一次读取不能冒充全文已读。
cloudVaultToolAllowedFolders|模型资料允许范围|限制模型工具可访问目录；扩大范围可能增加资料出站，需符合用户授权。`,'permissions'),
 ...rows(String.raw`voiceChat|语音聊天|配置识别与朗读服务；实时语音可能独立计费，非 HTTP 账本完整覆盖。
activeSkillPaths|启用技能|选择参与当前任务的技能，说明和工具会影响行为及上下文成本。
slashCommands|斜杠命令|管理输入框命令与提示模板；配置保存不等于运行命令。
enabledWorkflowHotkeys|工作流命令|选择暴露为命令的工作流；快捷键由 Obsidian 管理并检查冲突。
enabledWorkflowEventTriggers|工作流事件触发|将事件接到工作流；开启可能自动运行已有动作，需明确范围。
mcpServers|外部 MCP 服务|连接受信任外部工具；HTTP 与 stdio 启动方式、权限和费用不同。
agentPlugins|Agent 扩展|记录扩展及启用状态；配置不等于安装二进制或执行命令。
lastAIWorkflowModel|上次工作流模型|便于复用上次选择；服务移除后需重新选择有效模型。
lastTimelineAiModel|上次时间线模型|保存时间线操作的模型选择，不替代真实连接验证。
lastSelectedWorkflowPath|上次工作流路径|缺失时定位原文件，不因找不到入口而覆盖重建。
kakeratta|Kakeratta 联动|与已安装的 Kakeratta 功能联动；不使用时保留原关闭状态。
discord|Discord 联动|配置机器人和允许的用户/频道；启用前明确外部消息与权限范围。
langfuse|调用观测|设置观测目标和正文记录范围；记录正文可能外发私密内容。
dashboardHubMigrationNoticeShown|历史迁移提示|系统维护是否展示过旧提示，不用于重新运行迁移。`,'workflows'),
 ...rows(String.raw`editHistory|编辑历史与恢复|记录可恢复版本与差异；保留越多占用越大，不能代替完整备份。
encryption|内容与记录加密|控制受支持记录的加密；私钥和口令不进入普通读取与日志。`,'configuration-backup'),
};
export const WORKSPACE_DOCUMENTATION=rows(String.raw`selectedRagSetting|当前知识库|选择当前检索来源，外部只读和内部可写索引的更新方式不同。
webSearchEnabled|当前联网查询|启用受支持联网入口；保护策略或硬预算可能阻止无法预检的托管搜索。
selectedModel|当前聊天模型|以服务与模型 ID 选择；死引用需修复，不能把静默回退当命中原选择。
ragSettings|知识库配置|定义嵌入、分块、范围和检索参数；改变向量空间可能需要重建。
reasoningEffortByModel|推理倾向|记住实际模型支持的推理程度，较高通常增加耗时或费用。
maxPreviousMessages|远端历史数量|限制提交的旧消息；本地记录仍保留，工具调用与结果必须成对。
sentPromptHistory|已发送问题记录|系统维护输入历史，普通配置不应包含其资料正文。
discussionSettings|讨论运行状态|讨论功能维护的配置与结果，不能通过普通配置伪造已完成的运行。`,'retrieval');
export const GUARD_DOCUMENTATION=rows(String.raw`enabled|启用保护代理|决定是否处理经过 Safe Guard 的请求；直接绕过代理的流量不在此范围。
listenHost|代理监听地址|代理固定仅监听本机回环，不能改成公网或局域网监听。
listenPort|代理监听端口|更改后核对真实监听和客户端地址；端口冲突应保留待应用状态。
upstreamBaseUrl|代理上游服务|后续内容请求的转发目标，改变服务可能改变资料去向；需核对风险，不是 Agent 配置 MCP 地址。
warningEstimatedTokens|估算输入提醒|按估算 Token 提醒长输入，估算不是厂商账单。
blockEstimatedTokens|估算输入上限|阻止超过阈值的请求，提高会增加窗口与费用压力。
warningSingleMessageChars|单条字符提醒|输入过长时提前提醒，字符数不等于 Token 数。
blockSingleMessageChars|单条字符上限|阻止超长输入，长资料宜检索或分段读取。
contextWindowTokens|上下文窗口|窗口管理的容量依据，按实际模型规格核对，不按名称猜测。
warningTotalContextRatio|上下文提醒比例|达到窗口占比时提醒，在硬阻止前整理负载。
blockTotalContextRatio|上下文阻止比例|接近容量时阻止新负载，过高可能由上游先报错。
warningActualImages|图片数量提醒|按实际附图数量提醒，帮助控制视觉输入。
blockActualImages|图片数量上限|限制同时发送的图片数，避免过大视觉请求。
hardTimeoutSeconds|代理请求时限|过短会中断慢模型，过长会延迟失败反馈。
maxRequestBodyMB|请求体上限|限制代理接收负载体积，图片和长历史均占用额度。
showLowRiskNotices|轻提示显示|控制低风险提示频率，不改变真实保护限制。
defaultReadOnlyEnabled|默认只读保护|默认限制写入等动作；关闭会扩大能力，必须符合用户授权。
syncLlmHubUi|同步权限界面|让保护状态和聊天界面一致，避免显示与执行权限不符。
enforceProxyReadOnly|代理只读执行|在代理层限制写工具，不能用界面说明代替执行检查。
routerEnabled|自动模型路由|按任务选择路线，需要已配置可用目标，不虚构候选模型。
autoRouteImages|图片自动路由|将图片送到已配置视觉路线，需考虑图片出站与费用。
visionModel|视觉模型|指定实际图片模型，先确认服务支持再启用路线。
advancedRouteEnabled|高级路线|开放复杂任务的额外路线，可能增加外部调用和费用。
advancedProviderHint|高级服务提示|指定已配置服务倾向，不能替代有效服务实体。
advancedModelHint|高级模型提示|指定真实存在的候选模型，不把显示名称当有效 ID。
showRoutingNotices|路由提示|显示实际路线选择，便于识别模型切换和排错。
markdownVisionEnabled|笔记图片理解|让受支持链路发送 Markdown 图片，可能外发图片正文。
markdownVisionDirectProviderHook|直接服务图片桥接|直接 Provider 路线复用桥接，需核对实际附图及模型支持。
markdownVisionMaxImageMB|单图大小上限|过大的图片明确提示，避免无界加载。
markdownVisionShowNotices|图片桥接提示|显示识别、缺失和跳过状态，说明实际附图情况。
markdownVisionRenderChatImages|聊天图片预览|展示已发送图片，预览本身不代表模型识别成功。
markdownVisionRecognizeBarePaths|裸图片路径识别|识别未写标准嵌入语法的路径，开启后可能匹配更多内容。
contextManagerEnabled|上下文管理|按窗口整理远端负载，保留本地原始历史。
defaultCompressionModel|压缩模型|摘要所用模型，远端摘要可能独立计费。
compressionChunkTokens|摘要分组长度|每组摘要的估算输入量，应适合实际模型窗口。
compressionTargetTokens|摘要目标长度|过短丢细节，过长节省有限，应按任务验证。
compressionKeepRecentMessages|保留近期消息|压缩时保留最近原文，减少当前任务细节丢失。
contextHealthyRatio|健康占用比例|占用处于该范围内时显示健康状态。
contextWarningRatio|提醒占用比例|达到此比例提示整理，应低于危险阈值。
contextDangerRatio|危险占用比例|表示接近窗口容量，需要裁剪、摘要或另开任务。
deepSeekContextTokens|DeepSeek 窗口依据|对应路线的上下文容量，按实际模型规格核对。
deepSeekOutputReserveTokens|输出窗口预留|给生成预留空间；预留越多，可用输入越少。
contextMemories|上下文摘要状态|系统维护记忆与压缩结果，普通配置接口不返回资料正文。`,'permissions');
export const OTHER_DOCUMENTATION:Record<string,RootDocumentation>={
 'hotkeys.bindings':{title:'快捷键绑定',summary:'只管理本插件命令，保留已有绑定和明确解绑，冲突不能自动抢占。',userTopic:'customization'},
 'resources.files':{title:'受管自定义资源',summary:'只管理明确选定的库内脚本、预设或 Skills；导入不执行，不覆盖同名文件。',userTopic:'configuration-backup',risk:'high'},
};
export interface LeafDocumentation {title:string;summary:string}
const leafRows=String.raw`systemPrompt|联动回答习惯|提供此联动的语言和证据要求，会随相应模型请求发送，不替代权限。
modifiers|快捷键修饰键|指定 Ctrl、Alt 等组合，保存前核对 Obsidian 内已有绑定。
key|快捷键按键|指定组合中的主按键，不能自动抢占其他命令。
id|稳定标识|精确更新实体，显示名称与数组位置不能替代。
name|显示名称|帮助识别当前配置，不作为同名对象的永久身份。
enabled|启用开关|决定当前功能是否参与使用，不自动补齐服务或权限。
type|类型|选择当前对象实现类别，影响后续参数和执行路线。
description|用途说明|解释此配置用途，不改变底层访问权限。
label|显示文字|用户界面显示的名称或标签。
hidden|隐藏入口|仅隐藏入口，原配置与文件保留。
order|排列顺序|改变显示先后，不改变原动作回调。
actions|动作列表|选择阅读动作，保留原动作 ID 与执行路径。
contexts|显示场景|分别决定编辑、阅读预览、PDF 等场景是否展示。
editor|编辑场景|控制编辑器中的相应动作和入口。
preview|预览场景|控制 Markdown 阅读预览中的入口。
pdf|PDF 场景|控制内置 PDF 阅读器中的入口。
epub|EPUB 场景|控制可访问 EPUB 阅读器入口，第三方宿主可能不同。
file|文件菜单场景|控制文件列表或文件菜单的对应入口。
presentation|菜单样式|选择平铺或子菜单，仅改变呈现。
heroCollapsed|收起介绍|减少首页介绍占用，保留设置与帮助入口。
helpLinks|帮助链接|管理首页帮助入口，只接受受校验链接。
root|根目录|当前产物默认起点，改路径不自动移动原文件。
overrides|独立目录|为指定产物选择独立位置，为空按规则继承。
state|状态目录|存放工作区状态，不是原资料全文。
chats|聊天目录|存放相关聊天记录与导出内容。
diff|差异目录|存放编辑差异和恢复产物。
sources|资料产物目录|存放原资料处理后的受管产物。
rag|索引目录|存放知识库索引，变更前保留原索引。
tasks|任务目录|存放可恢复任务记录，不能伪造完成状态。
skills|技能目录|存放所选技能，启用且具权限时参与任务。
exports|导出目录|存放主动导出的产物，不是完整库备份。
pluginData|插件数据目录|存放受管配置产物，需遵守布局规则。
mode|处理策略|选择所属功能支持的工作模式，以枚举和帮助为准。
folderPatterns|目录匹配规则|选择包含或排除范围，匹配规则不同于完整路径。
filePattern|文件匹配规则|决定可触发当前处理或工作流的文件。
excludePatterns|排除规则|剔除不应处理或外发的内容。
attachmentFolder|附件位置|指定附件目录，保留原件与派生产物引用。
indexName|目标索引|选择派生资料的目标，不覆盖其他来源。
maxMarkdownChars|转换字符上限|超长输出明确截断，需要全文时继续读取原资料。
budgetEnabled|启用硬预算|未知费率或无法限价的请求可能被拒绝，仅覆盖受管 HTTP。
monthlyBudgetCny|月度预算|受管 HTTP 人民币月上限，外部 CLI/MCP/实时语音另计。
warningRatio|预算提醒比例|达到上限前提醒，给用户调整任务或费率的时间。
openingBalanceCny|本月已有支出|填入启用前费用，避免把月预算误当全部剩余额度。
openingBalanceMonth|支出所属月份|按 UTC 月记录已有支出，避免挪到账期之外。
maxOutputTokens|输出 Token 上限|过低会截断，过高需要更多预算预留。
maxToolRounds|工具回合上限|限制连续回合，避免长循环消耗预算。
maxContextChars|远端字符预算|限制外发上下文；零表示不启用该项裁剪，本地历史保留。
outbound|出站策略|选择原文、仅本地、脱敏或确认；文字规则不能脱敏二进制。
localOrigins|受信本地服务|填写完整服务 origin，不把远端伪装成本地。
redactionRules|脱敏规则|对文字替换，规则失败停止，不保证处理图片或 PDF。
pattern|匹配表达式|选择文本或路径范围，先用合成样本核对。
replacement|替换文字|匹配后的脱敏内容，不应再包含原秘密。
rates|人民币费率表|按账号实际价格填写并标版本，缺失不当免费。
origin|服务来源|完整协议与主机端口，不含路径、密钥或查询参数。
version|格式或费率版本|标识依据，便于核对兼容和账单。
inputPerMillion|输入费率|每百万输入 Token 的人民币单价。
outputPerMillion|输出费率|每百万输出 Token 的人民币单价，其他收费另核对。
cachedInputPerMillion|缓存命中费率|仅计算命中部分，不与未命中输入重复收费。
cacheWritePerMillion|缓存写入费率|提供方收取创建缓存费用时明确填写。
searchPerRequest|搜索调用费率|按次收费时的人民币单价，无法限制时预算保护拒绝。
codexCliPath|Codex 程序路径|引用已有 CLI，检查可能启动进程，不自动安装。
claudeCliPath|Claude 程序路径|保存已有程序路径不代表验证成功。
geminiCliPath|通用 CLI 路径|历史命令入口，按当前支持客户端核对。
codexCliModel|CLI 模型|选择客户端实际支持的模型，不虚构可用性。
codexCliReasoningEffort|CLI 推理倾向|按实际支持程度选择，影响耗时和可能费用。
codexCliVerified|Codex 检查状态|由检查维护，程序路径改变需重新检查。
claudeCliVerified|Claude 检查状态|不能通过普通外部配置伪造成功。
cliVerified|CLI 检查状态|程序检查结果不等于真实模型质量通过。
antigravityCliMigrated|历史 CLI 标记|系统维护的兼容状态，不触发旧迁移。
framework|本地服务协议|选真实接口协议，不能只凭名称或端口判断。
baseUrl|模型服务地址|填写对应协议入口，地址改变后原验证失效。
apiKey|服务密钥|本地填写，普通读取只显示是否配置。
username|认证用户名|认证身份，诊断中不回显秘密认证材料。
password|认证密码|只写凭据，不在预览与普通导出回显。
model|模型标识|用实际列表或用户确认的 ID，不只填显示名。
enabledModels|启用模型|决定可选模型，需符合实际服务能力。
availableModels|发现模型列表|由真实检查维护，不靠复制旧列表伪装验证。
verified|验证状态|系统检查维护，服务身份或凭据改变需失效。
verification|连接验证记录|受信检查保存的时间与内部连接绑定，只证明所执行的元数据或服务检查范围。
verifiedAt|检查时间|最近一次成功受信检查的时间戳，不能据此保证服务现在仍在线。
fingerprint|内部连接绑定|用于检测地址、协议或认证变化，外部只显示是否存在，不返回可猜测摘要。
maxTokens|生成长度上限|限制输出，结合实际窗口和费用核对。
temperature|回答随机程度|较低通常稳定，较高更发散，支持范围取决于模型。
streamIdleTimeoutSeconds|流式空闲时限|无新数据超时结束；过短会误判慢模型。
pdfInputMode|PDF 输入方式|按能力选文字或文件输入，不把扫描页当已提取全文。
autoReadAloud|自动朗读|回答后主动朗读，可能调用独立语音服务。
readAloudRate|朗读速度|改变播放语速，不改变生成文本。
speechPopupCommand|语音入口命令|选择受支持的语音入口，不执行任意字符串。
submitOnPaste|粘贴后发送|开启前理解粘贴可能立即触发外发。
submitPhrase|语音发送短语|指定触发发送的短语，避免听写意外提交。
allowedTools|允许工具|MCP 服务按连接记住已授权工具，移除后会重新询问。Agent 扩展用此字段限制可用工具。
toolHints|工具使用提示|帮助模型正确使用，不替代执行校验。
toolsUnsupportedModels|不支持工具的模型|记录不能可靠处理工具的模型，避免错误链路。
command|启动命令|可执行入口，保存不等于授权现在执行。
args|启动参数|传给程序，不混入未授权命令或公开秘密。
cwd|工作目录|外部程序运行位置，需明确可访问范围。
env|进程环境变量|可能含秘密，不进入普通读取或文档。
headers|HTTP 请求头|可能用于认证，普通读取隐藏敏感内容。
transport|MCP 传输|选择支持的 HTTP 或 stdio，决定连接与启动方式。
framing|stdio 封装|客户端与服务一致的消息格式，错误会握手失败。
url|服务或帮助地址|合法目标地址，拒绝脚本 URL 和分享秘密。
serverName|服务名称|用于显示和匹配，保持与实际服务一致。
serverId|服务标识|引用已有服务，不用显示顺序代替。
autoApprove|自动允许工具|可能扩大自动执行，仅在明确授权后启用。
repo|扩展来源仓库|记录来源，配置本身不安装或执行代码。
sourceType|扩展来源类型|区分发行版、分支等来源，影响版本定位。
sourceRef|扩展版本引用|固定标签或分支，避免模糊升级。
commitSha|扩展提交|核对来源版本，不证明代码安全。
skillNames|技能列表|记录扩展提供的技能，按任务需要启用。
executables|外部程序列表|列出涉及的程序，执行仍需相应权限。
pluginRoot|扩展位置|受管扩展路径，导入不覆盖用户同名文件。
path|文件或设备位置|按功能区分库内路径与程序路径，不自动搬移原资料。
skillPath|技能位置|引用已有技能，变化后核对依赖。
agentPlugin|扩展引用|关联已有 Agent 扩展，缺失时提示依赖。
activeBundleIds|启用技能包|保留包身份与引用，仅选择需要的技能。
promptTemplate|提示模板|影响任务回答和上下文，不是权限声明。
target|目标范围|不能默默扩大到整个知识库或所有文件。
searchSetting|搜索配置引用|引用存在的配置，缺失时先修复引用。
ragSetting|知识库引用|引用已有知识库，不根据显示顺序猜测。
searchSelection|选区搜索策略|控制从当前资料如何提取检索内容。
workflowId|工作流标识|引用已有工作流，不自动运行或覆盖。
events|事件列表|选择触发事件，开启后可能自动运行动作。
confirmEdits|编辑确认|关闭会减少用户检查机会，需符合授权。
contextLines|差异上下文|保留修改前后行，帮助理解与恢复。
maxResponseLength|回复长度上限|限制外部联动文本，长结果可能截断。
encryptChatHistory|加密聊天历史|加密受支持记录，需保管对应密钥。
encryptWorkflowHistory|加密工作流历史|恢复受支持记录依赖可用密钥。
publicKey|公开加密密钥|公开部分不能代替私钥解密。
encryptedPrivateKey|加密私钥|系统维护，不通过普通读取泄漏。
salt|派生盐|系统加密参数，不应随意更换。
secretKey|秘密密钥|仅用于受支持认证或加密，普通读取隐藏。
logPrompts|记录提示正文|可能将资料发给观测服务，需用户明确选择。
logResponses|记录回答正文|可能记录私密回答，核对位置和保留要求。
botToken|机器人令牌|本地填写，普通文档与日志不保存明文。
allowedUserIds|允许用户|限制外部联动用户，不默认对所有人开放。
allowedChannelIds|允许频道|限制触发范围，减少意外模型请求。
requireMention|要求提及|只有明确提及时响应，减少误触和费用。
respondToDMs|响应私信|明确私信资料与用户权限后启用。
webSearch|联网搜索|受发送策略和搜索费用边界约束。
tools|工具配置|允许的工具仍受实际执行权限检查。
enabledMcpServers|启用 MCP 服务|不因勾选而自动批准其所有工具。
legacy|历史兼容|保留旧行为，新设置优先使用正式入口。
pluginName|联动插件名|定位已安装插件，缺失不自动安装。
embeddingApiKey|嵌入密钥|索引/查询认证，留在本地安全存储。
embeddingApiKeyConfigured|嵌入凭据状态|系统维护是否配置，不代替真实连接检查。
embeddingBaseUrl|嵌入地址|变更可能使旧向量不兼容，不自动重建。
embeddingModel|嵌入模型|文档与查询需同空间，同维不同模型也不可混用。
chunkSize|文本块长度|按 JS 字符分块，大块上下文多，小块定位细但块数多。
chunkOverlap|重叠长度|增加减少边界遗漏，也增加索引和上下文冗余。
pdfChunkPages|原生 PDF 页组|一次原生嵌入的页数，不是本地文字分块或 OCR 质量。
topK|候选证据数量|多一些可能补足证据，也增加噪声、上下文和费用。
scoreThreshold|相似度门槛|提高更严格但可能漏检，降低更宽松但可能无关。
targetFolders|包含目录|只处理选定范围，移出后不应再召回旧片段。
searchFileExtensions|检索文件类型|限制展示类型，不新增原资料解析能力。
lastFullSync|最近同步记录|系统维护，不能伪造同步完成。
externalIndexPath|外部索引位置|只读引用旧索引，不以内部同步覆盖。
sourceRagSettings|组合索引来源|源需空间兼容且去重，不复制为新巨型向量库。
indexMultimodal|允许多模态资料|显式开放服务支持的 PDF/媒体，不同路线输入不同。
autoUpdateIndex|自动更新索引|保存后后台更新，可能调用嵌入；关闭仍可手动更新。
sourceCollection|派生集合归属|系统维护资料集合身份，不能外部伪造。
sourceManifestId|资料清单标识|关联原件与派生资料，改动会破坏追溯。
vaultToolMode|资料工具权限|扩大读写能力需明确授权。`;
export const LEAF_DOCUMENTATION:Record<string,LeafDocumentation>=Object.fromEntries(leafRows.split('\n').map(line=>{const[key,title,summary]=line.split('|');return[key,{title,summary}];}));
export const ROOT_DOCUMENTATION:Record<string,RootDocumentation>={
 ...Object.fromEntries(Object.entries(SETTINGS_DOCUMENTATION).map(([key,value])=>['settings.'+key,value])),
 ...Object.fromEntries(Object.entries(WORKSPACE_DOCUMENTATION).map(([key,value])=>['workspace.'+key,value])),
 ...Object.fromEntries(Object.entries(GUARD_DOCUMENTATION).map(([key,value])=>['safeGuard.'+key,value])),
 ...OTHER_DOCUMENTATION,
 'settings.requestControls':{...SETTINGS_DOCUMENTATION.requestControls,userTopic:'requests'},
 'settings.groundedAnswersByDefault':{title:'默认基于知识库回答',summary:'默认开启。选定可用知识库和文本模型后检索再回答，单次选择及远程发送决定仍由用户控制。',userTopic:'grounded-answers'},
};
