export function helpAnchors(text){
 const anchors=new Set([...text.matchAll(/<(?:a|h[1-6])\b[^>]*\bid=["']([a-z0-9-]+)["']/g)].map(match=>match[1]));
 for(const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)){
  const slug=match[1].toLowerCase().replace(/<[^>]+>/g,'').replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s+/g,'-');
  if(/^[a-z0-9-]+$/.test(slug))anchors.add(slug);
 }
 return [...anchors];
}
