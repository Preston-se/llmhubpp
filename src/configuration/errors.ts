import { ConfigurationError } from './types';
import { isSensitiveKey } from './validation';
const definitions:Record<string,[string,string,string,boolean]>={
 'embedding-endpoint-invalid':['EMBEDDING_ENDPOINT_INVALID','嵌入服务地址无效。','填写完整的 HTTP 或 HTTPS 地址，凭据放在单独字段中。',false],
 'embedding-credential-rebind-required':['EMBEDDING_CREDENTIAL_REBIND_REQUIRED','现有凭据属于旧的嵌入地址。','为新地址填写新凭据，或在本机清空旧凭据后保存地址。',false],
    'local-password-required':['LOCAL_PASSWORD_REQUIRED','配置包含加密凭据或自定义资源，尚未解锁，未生成部分导入预览。','在插件本地的配置导入/导出窗口输入原口令后预览；不要向 MCP 或聊天发送口令。',false],
    'wrong-password-or-corrupt':['WRONG_PASSWORD_OR_CORRUPT','配置包解锁失败，口令错误或加密内容损坏，未生成导入预览。','在插件本地核对原口令或改用完整备份包；没有应用任何导入内容。',true],
    'local-resource-export-required':['LOCAL_RESOURCE_EXPORT_REQUIRED','自定义资源需要本地加密导出，本次未生成空资源备份。','在插件设置的配置导入/导出窗口选择资源模块和具体文件路径，填写本地口令后导出。',false],
    'resource-paths-required':['RESOURCE_PATHS_REQUIRED','资源模块尚未选择具体文件，本次未生成空资源备份。','在本地配置导入/导出窗口填写资源路径；若不需要资源，请取消该模块。',true],
    'resource-not-found':['RESOURCE_NOT_FOUND','所选资源不在本次导出快照中，本次未生成部分资源备份。','重新核对资源路径和文件是否存在，再在本地读取所选文件后导出。',true],
    'connection-failed':['CONNECTION_FAILED','已有配置未通过本次连接检查。','核对地址、协议、认证和服务启动状态；按需先 probe，再显式 check，不伪造 verified。',true],
    'confirmation-required':['CONFIRMATION_REQUIRED','此预览含需要明确授权的风险变更。','向用户解释预览 risks 及影响；已有明确范围授权时，将同一预览 confirmation.token 作为 confirmToken 提交。',true],
    'confirmation-invalid':['CONFIRMATION_INVALID','风险确认回执与本次预览不匹配。','重新读取并预览，核对风险和授权后仅提交该预览的回执。',true],
    'reload-cancelled':['RELOAD_CANCELLED','运行时应用已取消或连接关闭。','重新查看 status，未观察成功的项目仍为待应用。',true],
    'upstream-unauthorized':['UPSTREAM_UNAUTHORIZED','上游拒绝了认证。','在插件本地核对凭据及访问权限；不要把密钥粘贴到对话。',true],
    'upstream-unreachable':['UPSTREAM_UNREACHABLE','未能连接到指定服务。','确认服务已启动、地址和代理正确，再探测同一明确目标。',true],
    'upstream-http-error':['UPSTREAM_HTTP_ERROR','上游返回了非成功 HTTP 状态。','核对 context.status、服务入口与该协议是否匹配；不会回显上游正文。',true],
    'invalid-upstream-response':['INVALID_UPSTREAM_RESPONSE','服务响应不符合所选探测协议。','按实际服务选择 Ollama、OpenAI 兼容或 MCP HTTP；不要只凭端口推断协议。',true],
    'upstream-response-too-large':['UPSTREAM_RESPONSE_TOO_LARGE','元数据响应超过探测大小上限。','检查是否误填网页或推理入口；本次未加载超过 1 MiB 的正文。',false],
    'probe-timeout':['PROBE_TIMEOUT','连接探测已超时。','确认本地服务状态和网络路线后重试，可按需增加 timeoutMs。',true],
    'probe-cancelled':['PROBE_CANCELLED','连接探测已取消。','需要时重新执行显式探测；配置未保存。',true],
    'credential-origin-mismatch':['CREDENTIAL_ORIGIN_MISMATCH','候选地址与凭据所属服务不同。','使用同 origin 的已有凭据引用，或在本地为新服务单独配置。',false],
    'outbound-policy':['OUTBOUND_POLICY','当前发送策略阻止了远程探测。','保留隐私选择；如确需远端连接，先向用户解释并调整发送范围。',false],
    'unknown-module':['UNKNOWN_MODULE','配置模块不存在。','modules 只接受模块名；字段路径请放在 fieldPaths，参考 didYouMean。',true],
    'unknown-field':['UNKNOWN_FIELD','配置字段路径不存在。','先调用 configuration_describe 查找字段；集合使用稳定 entityId 或 *，不用位置。',true],
    'unknown-or-readonly-field':['UNKNOWN_FIELD','字段不存在或不允许外部修改。','调用 configuration_describe 检查字段路径及 readOnly。',true],
    'entity-not-found':['UNKNOWN_ENTITY','目标配置实体不存在。','重新读取集合并使用当前稳定 entityId。',true],
    'conflict':['REVISION_CONFLICT','预览基线已变化，尚未覆盖当前配置。','重新 configuration_read 获取 revision，检查变化后重新 configuration_preview。',true],
    'preview-not-found':['PREVIEW_NOT_FOUND','找不到该预览，可能未创建、已使用或已被缓存淘汰。','先调用 configuration_preview，再使用本次返回的 id 和 baseRevision。',true],
    'preview-expired':['PREVIEW_EXPIRED','该预览已超过有效期。','重新 configuration_read 和 configuration_preview，不要重用过期预览。',true],
    'invalid':['VALIDATION_FAILED','配置值不符合当前约束。','检查 issues 和 configuration_describe 的字段类型、依赖及范围后重新 preview。',true],
    'invalid-arguments':['INVALID_ARGUMENTS','工具参数的结构或类型不正确。','按工具 inputSchema 提供参数；读取字段使用 fieldPaths，模块使用 modules。',true],
    'readonly':['READ_ONLY_FIELD','该字段由系统维护或只允许受信检查更新。','查询字段帮助；使用 configuration_check 验证，不手填 verified 等结果。',false],
    'recovery-required':['RECOVERY_REQUIRED','上次事务仍需恢复，当前暂停写入。','保留现场，可查询和导出；按本地故障排查指南处理后重试。',false],
    'busy':['BUSY','相关任务或请求正在运行。','等待任务完成或按用户意愿取消，再重新检查状态。',true],
    'dependency-unresolved':['DEPENDENCY_UNRESOLVED','模型选择引用了不存在或不可用的配置。','调用 configuration_resolve_model 查看原因，再用 configuration_repair 生成有效目标的预览。',true],
    'closed':['SERVICE_CLOSED','本机配置会话已经关闭。','在插件本地重新开启 Agent 辅助配置并更新连接信息。',true],
    'capability-unavailable':['CAPABILITY_UNAVAILABLE','当前宿主不提供该能力。','查看 configuration_status 的能力与本地操作指引。',false],
    'request-id-reused':['REQUEST_ID_REUSED','同一 requestId 已用于不同请求。','重试相同操作使用原参数；不同操作使用新的 requestId。',false],
    'save-failed':['SAVE_FAILED','保存失败，已恢复原配置。','检查本地磁盘权限与空间，重新读取后再预览。',true],
};
export function sanitizeConfigurationContext(value:unknown,key=''):unknown {
    if (isSensitiveKey(key)) return {redacted:true};
    if (Array.isArray(value)) return value.slice(0,100).map(item=>sanitizeConfigurationContext(item,key));
    if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,sanitizeConfigurationContext(item,name)]));
    if (typeof value==='string') {
        if (/^https?:\/\//i.test(value)) {
            try {const url=new URL(value);return url.origin+url.pathname;} catch {return '[invalid-url]';}
        }
        if (/Bearer\s+\S+|(?:api[_-]?key|password|secret)\s*[:=]/i.test(value)) return '[redacted]';
        return value.slice(0,600);
    }
    return value;
}
export function configurationError(error:unknown):Record<string,unknown> {
    const legacy=error instanceof ConfigurationError?error.code:'operation-failed';
    const definition=definitions[legacy]??[legacy==='operation-failed'?'OPERATION_FAILED':legacy.toUpperCase().replace(/-/g,'_'),'当前配置操作未完成。','查看字段帮助与 configuration_status，修正问题后按提示重试。',false];
    return {ok:false,error:legacy,code:definition[0],message:definition[1],hint:definition[2],retryable:definition[3],
        context:sanitizeConfigurationContext(error instanceof ConfigurationError?error.context:{}),
        issues:sanitizeConfigurationContext(error instanceof ConfigurationError?error.issues:[]),warnings:[],nextActions:legacy==='conflict'||legacy.startsWith('preview-')?['configuration_read','configuration_preview']:['configuration_status'],
        _meta:{'llmhubpp/contractVersion':'1.1','llmhubpp/schemaVersion':1}};
}
