/** Static Tailwind build — replaces the runtime CDN. Rebuild after changing utility
 *  classes: npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o static/css/tw.css --minify */
module.exports = { content: ['./static/index.html', './static/js/*.js'], theme: { extend: {} }, plugins: [] };
