const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const http = require('node:http');
const WebSocket = require('ws');
const { createAuth } = require('./auth');

function createApplication({ password, dataDir = __dirname, secureCookies = false, ...authOptions } = {}) {
    const auth = createAuth({ password, secureCookies, ...authOptions });
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 });
    const dataFile = path.join(dataDir, 'clipboard.txt');
    const uploadDir = path.join(dataDir, 'public', 'uploads');
    const fileDir = path.join(dataDir, 'public', 'files');
    const fileInfoFile = path.join(fileDir, 'file_info.json');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.mkdirSync(fileDir, { recursive: true });

    server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => {});
        if (req.url !== '/' || !auth.allowUpgrade(req)) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => {
            auth.registerSocket(ws, req);
            ws.on('error', () => {});
            wss.emit('connection', ws, req);
        });
    });

    function broadcast(data) {
        for (const client of wss.clients) {
            if (auth.allowSocket(client) && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        }
    }

    function clearDirectory(directory) {
        for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    }

    function storage(directory, prefix) {
        return multer.diskStorage({
            destination: (req, file, cb) => {
                try { clearDirectory(directory); cb(null, directory); } catch (error) { cb(error); }
            },
            filename: (req, file, cb) => cb(null, prefix + path.extname(file.originalname).toLowerCase())
        });
    }
    const limits = { fileSize: 100 * 1024 * 1024, files: 1 };
    const uploadImage = multer({
        storage: storage(uploadDir, 'cloud_latest'), limits,
        fileFilter: (req, file, cb) => {
            if (!/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.originalname)) {
                const error = new Error('请选择 PNG、JPEG、GIF、WebP、AVIF 或 BMP 图片');
                error.status = 400;
                return cb(error);
            }
            cb(null, true);
        }
    });
    const uploadFile = multer({ storage: storage(fileDir, 'cloud_latest_file'), limits });

    app.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'same-origin');
        next();
    });
    // 只公开登录页面，历史页面和其他项目文件不作为静态资源暴露。
    app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
    app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.js')));
    app.use('/api', auth.checkOrigin);
    app.use('/api/auth/login', express.json({ limit: '4kb' }));
    app.post('/api/auth/login', auth.login);
    app.post('/api/auth/logout', auth.logout);
    app.get('/api/auth/session', auth.requireAuth, (req, res) => res.json({ authenticated: true }));
    app.use('/api', auth.requireAuth, express.json({ limit: '1mb' }));
    const privateFileHeaders = res => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    };
    app.use('/uploads', auth.requireAuth, express.static(uploadDir, { setHeaders: privateFileHeaders }));
    app.use('/files', auth.requireAuth, express.static(fileDir, {
        setHeaders: res => {
            privateFileHeaders(res);
            res.setHeader('Content-Disposition', 'attachment');
        }
    }));

    app.get('/api/clip', (req, res) => {
        const content = fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf8') : '';
        res.json({ content });
    });
    app.post('/api/clip', (req, res) => {
        if (typeof req.body?.content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });
        fs.writeFileSync(dataFile, req.body.content, { encoding: 'utf8', mode: 0o600 });
        broadcast({ type: 'text', content: req.body.content });
        res.json({ success: true });
    });
    app.post('/api/upload', uploadImage.single('image'), (req, res) => {
        if (!req.file) return res.status(400).json({ error: '请选择图片' });
        const url = `/uploads/${req.file.filename}`;
        broadcast({ type: 'image', url });
        res.json({ url });
    });
    app.get('/api/image', (req, res) => {
        const files = fs.readdirSync(uploadDir);
        res.json({ url: files.length ? `/uploads/${files[0]}` : null });
    });
    app.post('/api/file_upload', uploadFile.single('file'), (req, res) => {
        if (!req.file) return res.status(400).json({ error: '请选择文件' });
        const fileInfo = {
            originalName: req.file.originalname, name: req.file.filename,
            size: req.file.size, type: req.file.mimetype, url: `/files/${req.file.filename}`
        };
        fs.writeFileSync(fileInfoFile, JSON.stringify(fileInfo), { encoding: 'utf8', mode: 0o600 });
        broadcast({ type: 'file', url: fileInfo.url, name: fileInfo.originalName, size: fileInfo.size });
        res.json(fileInfo);
    });
    app.get('/api/file_info', (req, res) => {
        const files = fs.readdirSync(fileDir).filter(file => file !== 'file_info.json');
        res.json(files.length && fs.existsSync(fileInfoFile) ? JSON.parse(fs.readFileSync(fileInfoFile, 'utf8')) : null);
    });
    app.delete('/api/file', (req, res) => {
        clearDirectory(fileDir);
        broadcast({ type: 'file', url: null });
        res.json({ success: true });
    });
    app.use((req, res) => res.status(404).json({ error: '资源不存在' }));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const status = error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large' ? 413
            : error instanceof multer.MulterError ? 400 : error.status || 500;
        res.status(status).json({ error: status === 413 ? '上传内容过大' : status >= 500 ? '服务器处理失败' : error.message });
    });

    function close() {
        auth.close();
        wss.close();
        server.closeAllConnections();
        return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    return { app, server, close };
}

if (require.main === module) {
    try {
        const envFile = path.join(__dirname, '.env');
        if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
        const port = Number(process.env.PORT || 3000);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535 的整数');
        const host = process.env.HOST || '127.0.0.1';
        const application = createApplication({
            password: process.env.ACCESS_PASSWORD,
            dataDir: process.env.DATA_DIR ? path.resolve(__dirname, process.env.DATA_DIR) : __dirname,
            secureCookies: process.env.COOKIE_SECURE === 'true'
        });
        application.server.on('error', error => {
            console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请修改 PORT 或停止占用服务。` : `启动失败：${error.code || '未知错误'}`);
            process.exit(1);
        });
        application.server.listen(port, host, () => console.log(`CloudClip 运行于 http://${host}:${port}`));
        for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => application.close().then(() => process.exit(0)));
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

module.exports = { createApplication };
