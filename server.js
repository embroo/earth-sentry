require('dotenv').config();
const { google } = require('googleapis');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const xmlParser = new XMLParser();

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // 모든 출처 허용 (개발용)
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.use(cors());

// YOUTUBE_API_KEY가 필요합니다.
const youtube = google.youtube({
    version: 'v3',
    auth: process.env.YOUTUBE_API_KEY // .env 파일에 YOUTUBE_API_KEY 설정 필요
});

// 유튜브 채널 RSS 피드 엔드포인트
app.get('/api/youtube-rss', async (req, res) => {
    try {
        let channelId = req.query.channelId;
        const username = req.query.username;

        if (!channelId && !username) {
            return res.status(400).json({ error: 'channelId or username is required' });
        }

        if (!channelId && username) {
            // 사용자 이름(@어쩌고)으로 채널 ID를 찾습니다.
            const url = `https://www.youtube.com/${username}`;
            const htmlRes = await axios.get(url, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
            });
            const html = htmlRes.data;
            const match = html.match(/<link rel="canonical" href="https:\/\/www.youtube.com\/channel\/([^"]+)">/);
            if (match) {
                channelId = match[1];
            } else {
                return res.status(404).json({ error: 'channelId not found for the given username' })
            }
        }

        const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        const response = await axios.get(rssUrl);

        // XML to JSON parsing
        const jsonObj = xmlParser.parse(response.data);

        // Extract relevant video data
        if (!jsonObj.feed || !jsonObj.feed.entry) {
            return res.json([]);
        }

        const entries = Array.isArray(jsonObj.feed.entry) ? jsonObj.feed.entry : [jsonObj.feed.entry];

        const videos = entries.slice(0, 5).map(entry => ({
            id: entry['yt:videoId'],
            title: entry.title,
            link: entry.link['@_href'],
            publishedAt: entry.published,
            thumbnail: `https://i.ytimg.com/vi/${entry['yt:videoId']}/hqdefault.jpg`,
            author: entry.author.name
        }));

        res.json(videos);
    } catch (error) {
        console.error('RSS Fetch Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch YouTube RSS data' });
    }
});


// 소켓을 통한 실시간 로직
let latestVideoId = null;
const TARGET_USERNAME = '@센서스튜디오';

async function fetchLatestYoutubeVideo() {
    try {
        const url = `https://www.youtube.com/${TARGET_USERNAME}`;
        const htmlRes = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        const match = htmlRes.data.match(/<link rel="canonical" href="https:\/\/www.youtube.com\/channel\/([^"]+)">/);

        if (!match) {
            console.log("Could not find channel id for", TARGET_USERNAME);
            return;
        }

        const channelId = match[1];
        const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        const response = await axios.get(rssUrl);
        const jsonObj = xmlParser.parse(response.data);

        if (jsonObj.feed && jsonObj.feed.entry) {
            const entries = Array.isArray(jsonObj.feed.entry) ? jsonObj.feed.entry : [jsonObj.feed.entry];
            if (entries.length > 0) {
                const latest = entries[0];
                const newVideoId = latest['yt:videoId'];

                // 새로운 영상이 발견되었을 때
                if (latestVideoId !== newVideoId) {
                    // 최초 실행이 아닐때만 알림 로그 출력
                    if (latestVideoId !== null) {
                        console.log(`[Youtube Sentry] New video detected: ${latest.title}`);
                    }
                    latestVideoId = newVideoId;

                    const videoData = {
                        id: newVideoId,
                        title: latest.title,
                        link: latest.link['@_href'],
                        publishedAt: latest.published,
                        thumbnail: `https://i.ytimg.com/vi/${newVideoId}/hqdefault.jpg`,
                        author: latest.author.name
                    };

                    io.emit('new_youtube_video', videoData);
                }
            }
        }
    } catch (err) {
        console.error("fetchLatestYoutubeVideo Error:", err.message);
    }
}

// 1분(60초)마다 스캔
setInterval(fetchLatestYoutubeVideo, 60000);
// 서버 시작과 동시에 최초 스캔 1회
fetchLatestYoutubeVideo();

io.on('connection', (socket) => {
    console.log('A client connected.');

    // 클라이언트가 처음 접속했을 때, 마지막으로 확인된 가장 최신 영상 정보를 보냅니다.
    socket.on('request_latest', async () => {
        try {
            const url = `https://www.youtube.com/${TARGET_USERNAME}`;
            const htmlRes = await axios.get(url, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
            });
            const match = htmlRes.data.match(/<link rel="canonical" href="https:\/\/www.youtube.com\/channel\/([^"]+)">/);
            if (match) {
                const channelId = match[1];
                const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
                const response = await axios.get(rssUrl);
                const jsonObj = xmlParser.parse(response.data);
                if (jsonObj.feed && jsonObj.feed.entry) {
                    const entries = Array.isArray(jsonObj.feed.entry) ? jsonObj.feed.entry : [jsonObj.feed.entry];
                    if (entries.length > 0) {
                        const latest = entries[0];
                        latestVideoId = latest['yt:videoId'];
                        socket.emit('new_youtube_video', {
                            id: latestVideoId,
                            title: latest.title,
                            link: latest.link['@_href'],
                            publishedAt: latest.published,
                            thumbnail: `https://i.ytimg.com/vi/${latestVideoId}/hqdefault.jpg`,
                            author: latest.author.name
                        });
                    }
                }
            }
        } catch (e) {
            console.error("Initial load error: ", e.message);
        }
    });

    socket.on('disconnect', () => {
        console.log('A client disconnected.');
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
