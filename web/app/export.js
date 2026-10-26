// Image/data export adapters for the server timeline view.
function exportNote(missing) {
  return missing.length ? ' · 缺少素材：' + missing.join('、') : '';
}
function exportBusy(value) {
  timeline.exporting = value;
  ['png', 'svg', 'json'].forEach((id) => ($(id).disabled = value || !model.matches.length));
}
async function svgBlob() {
  settleTimeline();
  return QS_ASSETS.exportSvg($('chart').querySelector('svg'));
}
function wireExport() {
  $('svg').onclick = async () => {
    exportBusy(true);
    try {
      const out = await svgBlob();
      download(out.blob, fileName('svg'));
      status('已导出 SVG' + exportNote(out.missing), !!out.missing.length);
    } catch (e) {
      status('导出失败：' + e.message, true);
    } finally {
      exportBusy(false);
    }
  };
  $('png').onclick = async () => {
    settleTimeline();
    const source = $('chart').querySelector('svg'),
      width = Number(source.getAttribute('width')) * 2,
      height = Number(source.getAttribute('height')) * 2;
    exportBusy(true);
    status(`正在导出 ${width} × ${height} 高清 PNG…`);
    let url;
    try {
      const out = await svgBlob(),
        image = new Image();
      url = URL.createObjectURL(out.blob);
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(Error('SVG 图片解码失败'));
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw Error('图片生成失败');
      download(blob, fileName('png'));
      status('已导出高清 PNG' + exportNote(out.missing), !!out.missing.length);
    } catch (e) {
      status('导出失败：' + e.message, true);
    } finally {
      if (url) URL.revokeObjectURL(url);
      exportBusy(false);
    }
  };
  $('json').onclick = () => {
    const data = {
      ...raw,
      historyExport: {
        retained: raw.matches.length,
        statisticsRange: $('statisticsRange').value,
        visibleMatchIds: model.matches.map((m) => m.mid)
      },
      visualization: {
        summary: model.summary,
        personalPrediction: model.personalPrediction,
        points: timeline.all.map((m) => ({
          mid: m.mid,
          mean: m.mean,
          observedMean: m.observedMean,
          confidenceEvidence: m.confidenceEvidence,
          estimateDetails: m.estimateDetails,
          estimateRange: m.estimateRange,
          performances: m.players.map((p) => ({ name: p.name, ...p.performance }))
        }))
      }
    };
    download(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      fileName('json')
    );
    status('已导出当前账号全部保留历史 JSON（不含凭据和签名包）');
  };
}
