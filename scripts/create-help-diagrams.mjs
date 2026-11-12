import {writeFile,readFile} from 'node:fs/promises';
const topics={
 index:['资料','检索','提问','引用','理解'],
 'first-setup':['连接服务','验证模型','配置嵌入','同步资料','阅读提问'],
 sources:['原文件','解析正文','版本输出','完整清单','专用索引'],
 retrieval:['选择范围','搜索','预览与理由','勾选条目','打开或插入'],
 reading:['阅读选区','调用右键','编辑草稿','发送问题','插入笔记'],
 'grounded-answers':['提出问题','检索证据','资料回答','回看引用','举例练习'],
 customization:['选择场景','调整动作','检查快捷键','保存偏好','实际触发'],
 storage:['工作区根','继承或独立','核对路径','保存配置','重载验证'],
 permissions:['允许范围','只读策略','模型工具','真实结果','诊断调整'],
 workflows:['可编辑预设','节点与脚本','权限边界','手动或事件','检查结果'],
 'mcp-agent-guide':['用户开启','本机连接','读取并预览','应用与验证','关闭服务'],
 'configuration-backup':['选择模块','加密自定义','导出配置','预览差异','合并恢复'],
 troubleshooting:['发现症状','定位阶段','检查依据','修正重试','验证结果'],
 'user-notice':['配置','权限','备份','试用','反馈'],
};
for(const [topic,steps]of Object.entries(topics)){
 const blocks=steps.map((label,i)=>{const x=18+i*174;return `<rect x="${x}" y="24" width="150" height="70" rx="10" fill="#244c4b" stroke="#65d8ce"/><text x="${x+75}" y="48" fill="#8be7de" font-size="12">${i+1}</text><text x="${x+75}" y="75" fill="#e4f5f1" font-size="17">${label}</text>${i<4?`<text x="${x+162}" y="67" fill="#65d8ce" font-size="20">→</text>`:''}`;}).join('');
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="122" viewBox="0 0 900 122"><rect width="900" height="122" rx="15" fill="#173333"/><g font-family="sans-serif" text-anchor="middle">${blocks}</g></svg>\n`;
 await writeFile(`resources/help/images/${topic}.svg`,svg);
 const path=`resources/help/${topic}.md`,text=await readFile(path,'utf8');await writeFile(path,text.replace('images/learning-flow.svg',`images/${topic}.svg`));
}
console.log(`Created ${Object.keys(topics).length} task-specific offline diagrams.`);
