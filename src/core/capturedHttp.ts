
import { EventEmitter } from 'events';
import type { NodeHttpModule } from 'obsidian-llm-hub-common/core';
import { createNodeFetch } from './proxyFetch';
/** Adapt the existing shared line parser to the same preflighted fetch transport as hosted providers. */
export function capturedHttpModule(protocol:string):NodeHttpModule {
  return {request(options,callback){
    const events=new EventEmitter(),abort=new AbortController();let body='';
    const hostname=options.hostname.includes(':')&&!options.hostname.startsWith('[')?'['+options.hostname+']':options.hostname;
    return {
      on(event,listener){events.on(event,listener);},
      write(data){body+=data;},
      end(){void (async()=>{
        try{
          const response=await createNodeFetch()(protocol+'//'+hostname+(options.port?':'+options.port:'')+options.path,{method:options.method,headers:options.headers,body,signal:abort.signal});
          const incoming=Object.assign(new EventEmitter(),{statusCode:response.status,statusMessage:response.statusText});
          callback(incoming);
          if(response.body){const reader=response.body.getReader();while(true){const item=await reader.read();if(item.done)break;incoming.emit('data',item.value);}}
          incoming.emit('end');
        }catch(error){events.emit('error',error instanceof Error?error:new Error('Request failed'));}
      })();},
      destroy(){abort.abort();},
    };
  }};
}
