const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escaped = text => `${text}`.replace(/[&<>"']/g, character => ESCAPES[character]);

const section = ({ name, owns, url }) => `<section>
<h2><a href="${escaped(url)}">${escaped(name)}</a></h2>
<p>${escaped(owns)}</p>
<iframe src="${escaped(url)}" title="Files and servers of ${escaped(name)}" loading="lazy"></iframe>
</section>`;

// Each pot's root page lists its files and its servers live, so the index frames those pages instead of copying them.
export const potsIndex = pots => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Pots</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; max-width: 72rem; margin: 0 auto; padding: 1.5rem; }
h2 { margin: 0; font-size: 1.15rem; }
p { margin: 0 0 0.5rem; color: GrayText; }
section { margin-bottom: 2rem; }
iframe { width: 100%; height: 24rem; border: 1px solid GrayText; border-radius: 8px; }
</style>
</head>
<body>
<h1>Pots</h1>
${pots.map(section).join('\n')}
</body>
</html>
`;
