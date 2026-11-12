/** Never automatically repeat failed or non-progressing work. */
export function hasMoreRagWork(result:{deferredFiles?:number;processed?:number;errors:string[];failedFiles?:string[]}):boolean{
 if(!result.deferredFiles)return false;
 if(result.errors.length||result.failedFiles?.length)throw new Error(`RAG部分处理失败；已保存结果保留：${[...result.errors,...(result.failedFiles||[])].slice(0,3).join('；')}`);
 if(!result.processed)throw new Error('RAG索引未取得进度，已停止自动重试；请检查文档或服务');
 return true;
}
