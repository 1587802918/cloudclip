const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server }); // 集成 WebSocket
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'clipboard.txt');
const UPLOAD_DIR = path.join(__dirname, 'public/uploads');
const FILE_UPLOAD_DIR = path.join(__dirname, 'public/files'); // 文件上传目录

// 确保所有上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(FILE_UPLOAD_DIR)) fs.mkdirSync(FILE_UPLOAD_DIR, { recursive: true });

// --- WebSocket 广播逻辑 ---
function broadcast(data, exclude) {
    wss.clients.forEach(client => {
        if (client !== exclude && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// ==========================================
// 1. Multer 配置：处理图片上传 (保留原逻辑)
// ==========================================
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        // 同步删除目录下所有旧文件
        const files = fs.readdirSync(UPLOAD_DIR);
        for (const f of files) fs.unlinkSync(path.join(UPLOAD_DIR, f));
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, 'cloud_latest' + ext); // 固定文件名
    }
});
const uploadImage = multer({ storage: imageStorage });

// ==========================================
// 2. Multer 配置：处理普通文件上传 (新增)
// ==========================================
const fileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        // 同步删除目录下所有旧文件
        const files = fs.readdirSync(FILE_UPLOAD_DIR);
        for (const f of files) fs.unlinkSync(path.join(FILE_UPLOAD_DIR, f));
        cb(null, FILE_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, 'cloud_latest_file' + path.extname(file.originalname)); // 固定文件名
    }
});
const uploadFile = multer({ storage: fileStorage });

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// 3. 基础路由与文本 API (保留)
// ==========================================
app.get('/api/clip', (req, res) => {
    const content = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : '';
    res.json({ content });
});

app.post('/api/clip', (req, res) => {
    const { content } = req.body;
    fs.writeFileSync(DATA_FILE, content || '', 'utf8');
    // 广播文字更新
    broadcast({ type: 'text', content: content });
    res.json({ success: true });
});

// ==========================================
// 4. 图片上传与获取 API (保留)
// ==========================================
app.post('/api/upload', uploadImage.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '上传失败' });
    const url = `/uploads/${req.file.filename}`;
    // 广播图片更新
    broadcast({ type: 'image', url: url });
    res.json({ url });
});

app.get('/api/image', (req, res) => {
    const files = fs.readdirSync(UPLOAD_DIR);
    if (files.length > 0) {
        res.json({ url: `/uploads/${files[0]}` });
    } else {
        res.json({ url: null });
    }
});

// ==========================================
// 5. 普通文件上传与获取 API (新增)
// ==========================================
// 用于保存文件原始信息的临时数据文件
const FILE_INFO_FILE = path.join(FILE_UPLOAD_DIR, 'file_info.json');

app.post('/api/file_upload', uploadFile.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '上传失败' });
    
    // 记录文件原始信息
    const fileInfo = {
        originalName: req.file.originalname,
        name: req.file.filename,
        size: req.file.size,
        type: req.file.mimetype,
        url: `/files/${req.file.filename}`
    };
    fs.writeFileSync(FILE_INFO_FILE, JSON.stringify(fileInfo), 'utf8');

    // 广播新文件信息
    broadcast({ type: 'file', url: fileInfo.url, name: fileInfo.originalName });
    res.json({ url: fileInfo.url, name: fileInfo.originalName });
});

app.get('/api/file_info', (req, res) => {
    // 检查是否有文件存在（除了 file_info.json 本身）
    const files = fs.readdirSync(FILE_UPLOAD_DIR).filter(f => f !== 'file_info.json');
    
    if (files.length > 0 && fs.existsSync(FILE_INFO_FILE)) {
        // 读取文件原始信息
        const fileInfo = JSON.parse(fs.readFileSync(FILE_INFO_FILE, 'utf8'));
        res.json(fileInfo);
    } else {
        res.json(null);
    }
});

// 6. 添加一个删除文件的接口，方便用户清空
app.delete('/api/file', (req, res) => {
    const files = fs.readdirSync(FILE_UPLOAD_DIR);
    for (const f of files) fs.unlinkSync(path.join(FILE_UPLOAD_DIR, f));
    // 广播文件已删除
    broadcast({ type: 'file', url: null });
    res.json({ success: true });
});


server.listen(PORT, () => console.log(`🚀 实时同步传输站运行在 http://localhost:${PORT}`));