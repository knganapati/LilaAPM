# LILA BLACK: Player Journey Visualization Tool - Architecture Overview

## Tech Stack Decisions
- **Data Processing**: Python (Pandas/Pyarrow) chosen for its high-performance Parquet handling.
- **Frontend**: Vanilla JavaScript + HTML5 Canvas chosen for maximum rendering performance and zero runtime dependencies.
- **Styling**: Vanilla CSS with modern flexbox/grid and a premium dark-themed gaming aesthetic.
- **Architecture**: Static Site + Pre-processed Data (JSON). This eliminates the need for a live database or complex backend, ensuring high reliability and zero-cost hosting.

## Data Pipeline Flow
1. **Extraction**: Raw parquet files are extracted and organized by day.
2. **Standardization**: Python scripts read all parquet files, decoding bytes into strings and cleaning match/user IDs.
3. **MAPPING**: World coordinates `(x, z)` are converted to `(u, v)` space and then to pixel coordinates for the 1024x1024 minimap images using the formula provided in the README.
4. **Aggregation**: 
   - `matches_index.json`: Lightweight metadata for the sidebar selector (Match ID, Map, Stat Counts).
   - `heatmaps.json`: Map-wide density clusters for kills, deaths, traffic, and loot.
   - `Individual Match Files`: Normalized timelines (0 to N milliseconds) for each match.
5. **Consumption**: The browser fetches the index once, and then fetches specific match JSONs on-demand to keep memory usage low.

## Key Features & Design
- **Multi-Layer Canvas**: Separate layers for Heatmaps (static), Trails (growing), and Markers (fading). This allows redrawing trails at 60fps without recalculating heatmap density.
- **Bot vs Human**: Color-coded trails (Cyan for Humans, Orange for Bots) and filtered markers.
- **Timeline Scrubbing**: Interactive playback with 1x to 10x speed and manual scrubbing via the timeline bar.
- **Heatmap Intelligence**: Toggleable views for Traffic, Kills, Deaths, and Loot hotspots to help Level Designers identify "dead zones" or "choke points."

## Trade-offs & Future Considerations
- **Minimap Sizes**: Minimap images are 10MB+. In a production tool, these would be served as WebP or tiled map layers (like Leaflet) for faster initial loads.
- **Client-Side Processing**: While pre-processing is used, extremely long matches (30m+) might strain lower-end devices. I'd implement trail chunking if scaling to longer durations.
- **Interactive Tooltips**: Current tooltips show raw pixels; with more time, I'd implement spatially-indexed search (R-tree) to show player-specific death notes on hover.

## Deliverables
- **Tool**: [Hosted locally at localhost:8000 during test]
- **Repository**: Code organized in `d:\Agent\lila-viz\`
- **Data**: Processed JSONs in `d:\Agent\lila-viz\public\data\`
