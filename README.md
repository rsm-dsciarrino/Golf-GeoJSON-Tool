# Golf-GeoJSON-Tool
web app to create golf geometry geojson files with a Claude API

golf-geojson-tool/
├── .devcontainer/         # Codespace config
├── viewer/                # Mapbox viewer app
│   ├── server.js          # Express server
│   ├── public/
│   │   └── index.html     # Mapbox map + auto-refresh
│   └── package.json
├── mcp-server/            # MCP server
│   ├── index.js
│   └── package.json
├── skill/                 # Claude skill
│   └── SKILL.md
└── README.md
