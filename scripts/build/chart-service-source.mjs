// Keep explicit local -> cloud synchronization compatible with the extracted API.
export function chartServiceSource(source) {
  if (source.includes('function createChartService(')) return source;
  const marker = 'const QS_CHART_VERSION=';
  if (
    !source.includes(marker) ||
    !source.includes('function renderChart(model,art,showArt,title){')
  )
    throw Error('Unrecognized local chart source');
  const start = source.indexOf('function renderChart(model,art,showArt,title){');
  return (
    source.slice(0, start) +
    `function createChartService({core:QS,maps={},avatar='',rankArt={}}){
 const QS_DATA={maps},QS_AVATAR=avatar,QS_RANK_ART=rankArt;
` +
    source.slice(start) +
    `
 return Object.freeze({render(model,{art={},showArt=true,title='快速强度图'}={}){return renderChart(model,art,showArt,title);}});
}
globalThis.OWQS_CREATE_CHART_SERVICE=createChartService;
function renderChart(model,art,showArt,title){
 return createChartService({core:QS,maps:QS_DATA.maps,avatar:typeof QS_AVATAR==='undefined'?'':QS_AVATAR,rankArt:typeof QS_RANK_ART==='undefined'?{}:QS_RANK_ART}).render(model,{art,showArt,title});
}
`
  );
}
