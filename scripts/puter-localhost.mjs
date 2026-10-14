/**
 * Dev-server plugin: `npm run dev` prints and opens the app at
 * http://<name>.puter.localhost:<port>/ instead of http://localhost:<port>/.
 * Browsers resolve every *.localhost name to loopback on their own, and Vite
 * accepts .localhost hosts by default, so nothing else needs configuring.
 */
export default function puterLocalhost(name) {
  return {
    name: 'puter-localhost',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.on('listening', () => {
        const local = server.resolvedUrls?.local[0];
        if (!local) return;
        const url = new URL(local);
        url.hostname = `${name}.puter.localhost`;
        server.resolvedUrls.local = [url.href];
      });
    },
  };
}
