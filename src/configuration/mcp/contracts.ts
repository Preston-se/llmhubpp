const object={type:'object'},text={type:'string'};
const descriptions:Record<string,[string,string,string,string]>={
    reload:['应用受支持运行时变更','按 scopes 白名单安全重启 Safe Guard 代理或刷新已支持客户端事件，保留当前配置 MCP。','不重启整个插件、不执行命令；忙时返回 BUSY，不能在线应用的路径给本地步骤。','先读当前 revision；只有实际监听/运行结果符合当前配置才清除 pending，失败仍待应用。'],
    probe:['探测候选 HTTP 连接','按明确 URL 读取 Ollama/OpenAI 兼容模型列表或进行 MCP HTTP 握手；支持超时和取消。','不保存配置、不发推理、不启动 CLI/stdio、不扫描；已有配置检查并保存验证状态用 check。','地址不得带认证、查询或片段；凭据只引用同 origin 的已有配置；成功只代表本次元数据/握手范围。'],
    status:['当前配置可用状态','先查看模型严格解析、资料配置、保护、事务恢复与待应用状态；默认不联网、不读全库向量、不写配置。','模型或上游可达需显式 probe/check；indexReady=unknown 不能当作已同步成功。','recoveryRequired=true 时保留现场并按本地恢复指引处理，仍可查询/导出；空配置按核心答案引导，旧选择失效先修复。'],
    resolve_model:['解析保存的模型选择','按实际标识规则检查当前或指定 model；区分缺服务、禁用、未验证和模型未启用。','不会自动选其他服务、联网或修改 selectedModel；候选建议不是修复已完成。','模型名中的冒号必须保留；旧标识补默认模型会明确报告 resolutionSource。'],
    repair:['预览模型引用修复','不传目标时仅给建议；传 targetModel/baseRevision 时为该明确目标生成原事务 preview。','不会选第一个模型、重建 Provider 或直接保存；真正保存使用 configuration_apply。','目标必须已配置可用，用户确认选择后再使用；并发修改时重读修订重新预览。'],
    describe:['配置字段与约束','按模块或字段路径查询可写范围、类型和帮助；新任务先用 detail=summary，完整 schema 按需读取。','查看当前值用 read，连接检查用 check；此工具不验证网络或保存配置。','非法模块和字段会报错；集合以稳定 entityId 操作。'],
    read:['读取当前配置','读取脱敏配置及 revision；优先传 fieldPaths 精确读取，modules 仅接受模块名。','修改前生成 preview；读取成功不能证明模型或索引已经可用。','无新过滤参数保留整模块兼容行为；fieldPaths 与模块查询均支持 limit/cursor，存在 nextCursor 时继续分页；密钥只显示 configured 状态。'],
    preview:['预览配置变更','以当前 baseRevision 校验最多 200 项操作并返回差异、保护放宽风险和十分钟有效的预览。','只想读值用 read；本工具不保存、不发网络、不转换资料、不执行脚本。','风险按变化方向判定；旧预览或并发修改需重新读取；集合修改使用 entityId，不能按数组位置。'],
    apply:['应用已预览配置','提交同一 previewId/baseRevision，requestId 用于同一次请求的安全重试；结果区分保存与运行时应用。','仅校验用 preview，检查连通性用 check；不要以重复 apply 代替状态复查。','有风险时解释 risks 并核对已有范围授权，提交同一预览的 confirmation.token 作为 confirmToken；回执不证明人类同意。冲突/过期先重读重做 preview。'],
    verify:['复查历史配置操作','用 operationId 复查已应用操作及其后是否发生修改。','此工具不主动发网络，连接/模型检查用 check；当前运行情况用 status。','unchangedSinceApply=false 表示后续有变化，不等同保存失败；externalChecks 未运行时不能声称连接可用。'],
    history:['查看配置变更记录','查看最近脱敏配置回执，按 operationId 追踪结果。','恢复用 restore，完整跨重载备份用配置包；历史记录不是完整秘密备份。','恢复快照只在当前插件运行内，记录可跨重载；不要把已有记录当作当前运行状态。'],
    restore:['恢复本次运行的配置','恢复 operationId 对应的会话快照，要求当前 baseRevision，使用独立 requestId。','跨重载恢复用配置包；有后续修改时不要强制覆盖。','快照失效或修订冲突时重新检查；不会执行被配置的脚本或索引任务。'],
    check:['检查受管连接','显式检查已有 API、本地、嵌入、MCP、路径或 CLI 配置；API/local/CLI 成功检查可更新系统验证信息。','仅需候选端点探测用 probe，历史保存核对用 verify；preview 不会自动执行本检查。','可能联网或启动已配置的 CLI/MCP；按用户已授权范围选择目标，不把列出模型等同真实问答质量。'],
    export:['导出普通配置包','导出无凭据配置并取得当前会话下载句柄；用于用户要求的备份。','携带秘密或自定义资源需本地加密流程，不能把普通包当全文资料/向量备份。','includeResources=true 或 modules 含 resources 返回 LOCAL_RESOURCE_EXPORT_REQUIRED，不生成空资源备份；关闭/轮换会话后句柄失效。'],
    import_preview:['预览配置包导入','以已经上传的 uploadHandle 预览模块合并，得到普通 preview 后复用 apply。','本工具不直接写入；加密包返回 LOCAL_PASSWORD_REQUIRED，须在插件本地解锁，不上传口令，不生成部分恢复预览。','先认证 POST 原始 ZIP 到 /configuration-bundles 取得句柄；合并快照绑定 baseRevision，并发保存需重读重新合并，核对路径映射、缺失依赖和资源冲突。'],
};
const schemas:Record<string,Record<string,unknown>>={
    reload:{revision:text,status:{enum:['applied','pending','manual-action-required']},applied:{type:'array',items:text},pending:{type:'array',items:text},localSteps:{type:'array',items:text}},
    probe:{success:{type:'boolean'},kind:text,scope:{enum:['metadata-only','handshake-only']},models:{type:'array',items:text},protocolVersion:text,capabilities:{type:'array',items:text},elapsedMs:{type:'number'}},
    status:{revision:text,recoveryRequired:{type:'boolean'},plugin:object,model:object,guard:object,rag:object,reload:object,setup:object},
    resolve_model:{selected:{type:['string','null']},effective:text,resolved:{type:['object','null']},ready:{type:'boolean'},reason:{type:['string','null']},suggestions:{type:'array',items:text},runtimeFallback:object,verification:{enum:['legacy','unverified','current','stale']},verifiedAt:{type:'number'}},
    repair:{revision:text,preview:{type:'boolean'},id:text,baseRevision:text,changes:{type:'array'},suggestions:{type:'array',items:text}},
    describe:{fields:{type:'array',items:object},nextCursor:text},read:{revision:text,modules:object,values:object,empty:{type:'boolean'},nextCursor:text},
    preview:{id:text,baseRevision:text,expiresAt:{type:'number'},changes:{type:'array',items:object},issues:{type:'array'},reloadRequired:{type:'boolean'}},
    apply:{operationId:text,revision:text,status:{enum:['applied','reload-required','verification-failed','recovery-required']},issues:{type:'array'}},
    verify:{operationId:text,status:text,unchangedSinceApply:{type:'boolean'},externalChecks:text},
    history:{entries:{type:'array',items:object}},restore:{operationId:text,revision:text,status:text},check:{success:{type:'boolean'},models:{type:'array',items:text},tools:{type:'array',items:object},exists:{type:'boolean'},scope:text,path:text,snapshot:object},export:{handle:text,path:text},import_preview:{id:text,baseRevision:text,changes:{type:'array'},issues:{type:'array'},reloadRequired:{type:'boolean'}},
};
const required:Record<string,string[]>={probe:['success','kind','scope','elapsedMs'],reload:['revision','status','applied','pending','localSteps'],status:['revision','model','setup','guard','rag'],resolve_model:['selected','resolved','ready','reason','suggestions'],repair:['preview','suggestions','changes'],describe:['fields'],read:['revision'],preview:['id','baseRevision','changes'],apply:['operationId','revision','status'],verify:['operationId','status'],history:['entries'],restore:['operationId','revision','status'],export:['handle','path'],import_preview:['id','baseRevision','changes','issues','reloadRequired']};
const variants:Record<string,unknown[]>={
    probe:[{properties:{scope:{const:'metadata-only'},kind:{enum:['ollama','openai-compatible']}},required:['models']},{properties:{scope:{const:'handshake-only'},kind:{const:'mcp-http'}},required:['protocolVersion','capabilities']}],
    check:[{required:['success']},{required:['models']},{required:['tools']},{required:['exists','scope']},{required:['path','exists','snapshot']}],
};
export function toolContract(name:string):{title:string;description:string;outputSchema:Record<string,unknown>;idempotentHint:boolean} {
    const key=name.replace(/^configuration_/,''),[title,purpose,notWhen,critical]=descriptions[key]??[key,'查询受支持配置能力。','不执行未授权内容操作。','先检查当前修订及工具参数。'];
    return {title,description:purpose+'\n适用：需要 '+title+' 时使用。\n不适用：'+notWhen+'\n关键约束：'+critical+'\n自检：按结果的 warnings、nextActions 和 status 决定下一步，不猜测成功。',
        outputSchema:{type:'object',properties:{ok:{type:'boolean'},error:text,code:text,message:text,hint:text,retryable:{type:'boolean'},context:object,warnings:{type:'array'},nextActions:{type:'array',items:text},_meta:object,...schemas[key]},
            required:['ok','warnings','nextActions','_meta'],anyOf:[{properties:{ok:{const:true},...(['probe','check'].includes(key)?{success:{const:true}}:{})},required:required[key]??[],...(variants[key]?{anyOf:variants[key]}:{})},{properties:{ok:{const:false}},required:['code','message','hint','retryable','context']}]},
        idempotentHint:!['check','export','import_preview'].includes(key)};
}
export function configurationSuccess(value:unknown):Record<string,unknown> {
    const result:Record<string,unknown>=value && typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{result:value};
    return {...result,ok:true,warnings:Array.isArray(result.warnings)?result.warnings:[],nextActions:Array.isArray(result.nextActions)?result.nextActions:[],
        _meta:{'llmhubpp/contractVersion':'1.1','llmhubpp/schemaVersion':1}};
}
