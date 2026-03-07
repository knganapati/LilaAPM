"""
Data processing script for LILA BLACK Player Journey Visualization.
Reads all parquet files and produces optimized JSON for the frontend.
"""
import sys
sys.path.insert(0, r'd:\Agent\pylibs')

import pyarrow.parquet as pq
import pandas as pd
import os
import json
import re
from pathlib import Path
from collections import defaultdict

DATA_ROOT = r'd:\Agent\player_data\player_data'
OUTPUT_DIR = r'd:\Agent\lila-viz\public\data'

# Map configurations from README
MAP_CONFIG = {
    'AmbroseValley': {'scale': 900, 'origin_x': -370, 'origin_z': -473},
    'GrandRift':     {'scale': 581, 'origin_x': -290, 'origin_z': -290},
    'Lockdown':      {'scale': 1000, 'origin_x': -500, 'origin_z': -500},
}

DAYS = ['February_10', 'February_11', 'February_12', 'February_13', 'February_14']

def is_bot(user_id):
    """Bots have short numeric IDs, humans have UUIDs."""
    return bool(re.match(r'^\d+$', str(user_id)))

def world_to_pixel(x, z, map_id):
    """Convert world coordinates to minimap pixel coordinates (1024x1024)."""
    cfg = MAP_CONFIG.get(map_id)
    if not cfg:
        return None, None
    u = (x - cfg['origin_x']) / cfg['scale']
    v = (z - cfg['origin_z']) / cfg['scale']
    pixel_x = u * 1024
    pixel_y = (1 - v) * 1024
    return round(pixel_x, 1), round(pixel_y, 1)

def load_all_data():
    """Load all parquet files into a single DataFrame."""
    frames = []
    total_files = 0
    errors = 0
    
    for day in DAYS:
        day_path = os.path.join(DATA_ROOT, day)
        if not os.path.isdir(day_path):
            print(f"  Skipping {day} - not found")
            continue
        
        files = [f for f in os.listdir(day_path) if not f.startswith('.')]
        print(f"  Loading {day}: {len(files)} files...")
        
        for fname in files:
            filepath = os.path.join(day_path, fname)
            try:
                table = pq.read_table(filepath)
                df = table.to_pandas()
                df['day'] = day
                df['filename'] = fname
                frames.append(df)
                total_files += 1
            except Exception as e:
                errors += 1
                if errors <= 5:
                    print(f"    Error reading {fname}: {e}")
    
    print(f"\n  Total files loaded: {total_files}, Errors: {errors}")
    combined = pd.concat(frames, ignore_index=True)
    
    # Decode event column
    combined['event'] = combined['event'].apply(
        lambda x: x.decode('utf-8') if isinstance(x, bytes) else str(x)
    )
    
    # Clean match_id - remove .nakama-0 suffix for display
    combined['match_id_clean'] = combined['match_id'].str.replace('.nakama-0', '', regex=False)
    
    # Determine if bot
    combined['is_bot'] = combined['user_id'].apply(is_bot)
    
    # Convert timestamps to milliseconds (numeric) 
    # ts is datetime64[ms], but the raw values are actually SECONDS (mapped to 2026).
    # Interpretation as ms puts them in Jan 1970. Multiply by 1000 to correct.
    combined['ts_ms'] = combined['ts'].values.astype('int64') * 1000
    
    # Compute pixel coordinates
    pixels = combined.apply(
        lambda row: world_to_pixel(row['x'], row['z'], row['map_id']), axis=1
    )
    combined['px'] = [p[0] for p in pixels]
    combined['py'] = [p[1] for p in pixels]
    
    return combined

def build_matches_index(df):
    """Build an index of all matches with metadata."""
    matches = {}
    
    for match_id, group in df.groupby('match_id_clean'):
        map_id = group['map_id'].iloc[0]
        day = group['day'].iloc[0]
        
        humans = group[~group['is_bot']]['user_id'].nunique()
        bots = group[group['is_bot']]['user_id'].nunique()
        
        events = group['event'].value_counts().to_dict()
        
        ts_min = group['ts_ms'].min()
        ts_max = group['ts_ms'].max()
        duration_s = (ts_max - ts_min) / 1000
        
        players_list = []
        for uid, pgroup in group.groupby('user_id'):
            player_events = pgroup['event'].value_counts().to_dict()
            players_list.append({
                'id': str(uid),
                'is_bot': is_bot(uid),
                'events': player_events,
                'n_events': len(pgroup),
            })
        
        matches[match_id] = {
            'id': match_id,
            'map': map_id,
            'day': day,
            'humans': humans,
            'bots': bots,
            'total_events': len(group),
            'event_counts': events,
            'duration_s': round(duration_s, 1),
            'players': players_list,
        }
    
    return matches

def build_match_data(df, match_id):
    """Build detailed data for a single match (for timeline playback)."""
    match_df = df[df['match_id_clean'] == match_id].copy()
    match_df = match_df.sort_values('ts_ms')
    
    # Normalize timestamps to start from 0
    t_min = match_df['ts_ms'].min()
    match_df['t'] = match_df['ts_ms'] - t_min
    
    # Build player trails and events
    players = {}
    events_list = []
    
    for uid, pgroup in match_df.groupby('user_id'):
        uid_str = str(uid)
        bot = is_bot(uid)
        
        # Separate position events from action events
        pos_events = pgroup[pgroup['event'].isin(['Position', 'BotPosition'])]
        action_events = pgroup[~pgroup['event'].isin(['Position', 'BotPosition'])]
        
        # Build trail (position over time)
        trail = []
        for _, row in pos_events.iterrows():
            if row['px'] is not None:
                trail.append([int(row['t']), row['px'], row['py']])
        
        players[uid_str] = {
            'id': uid_str,
            'bot': bot,
            'trail': trail,
        }
        
        # Build events
        for _, row in action_events.iterrows():
            if row['px'] is not None:
                events_list.append({
                    't': int(row['t']),
                    'px': row['px'],
                    'py': row['py'],
                    'type': row['event'],
                    'player': uid_str,
                    'bot': bot,
                })
    
    events_list.sort(key=lambda e: e['t'])
    
    return {
        'players': players,
        'events': events_list,
        'duration': int(match_df['t'].max()),
    }

def build_heatmap_data(df):
    """Build heatmap data for each map (kill zones, death zones, traffic)."""
    heatmaps = {}
    
    for map_id in MAP_CONFIG.keys():
        map_df = df[df['map_id'] == map_id]
        
        # Kill heatmap (Kill + BotKill events)
        kills = map_df[map_df['event'].isin(['Kill', 'BotKill'])]
        kill_points = [[row['px'], row['py']] for _, row in kills.iterrows() if row['px'] is not None]
        
        # Death heatmap (Killed + BotKilled + KilledByStorm)
        deaths = map_df[map_df['event'].isin(['Killed', 'BotKilled', 'KilledByStorm'])]
        death_points = [[row['px'], row['py']] for _, row in deaths.iterrows() if row['px'] is not None]
        
        # Storm death heatmap
        storm = map_df[map_df['event'] == 'KilledByStorm']
        storm_points = [[row['px'], row['py']] for _, row in storm.iterrows() if row['px'] is not None]
        
        # Traffic/movement heatmap (sample position events to keep size reasonable)
        positions = map_df[map_df['event'].isin(['Position', 'BotPosition'])]
        # Sample every 3rd position to reduce data size
        sampled = positions.iloc[::3]
        traffic_points = [[row['px'], row['py']] for _, row in sampled.iterrows() if row['px'] is not None]
        
        # Loot heatmap
        loot = map_df[map_df['event'] == 'Loot']
        loot_points = [[row['px'], row['py']] for _, row in loot.iterrows() if row['px'] is not None]
        
        heatmaps[map_id] = {
            'kills': kill_points,
            'deaths': death_points,
            'storm_deaths': storm_points,
            'traffic': traffic_points,
            'loot': loot_points,
        }
    
    return heatmaps

def main():
    print("="*60)
    print("LILA BLACK - Data Processing Pipeline")
    print("="*60)
    
    # Create output directory
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # Step 1: Load all data
    print("\n[1/4] Loading all parquet data...")
    df = load_all_data()
    print(f"  Total rows: {len(df):,}")
    print(f"  Columns: {list(df.columns)}")
    print(f"  Maps: {df['map_id'].unique()}")
    print(f"  Events: {df['event'].value_counts().to_dict()}")
    print(f"  Unique matches: {df['match_id_clean'].nunique()}")
    print(f"  Unique players (human): {df[~df['is_bot']]['user_id'].nunique()}")
    print(f"  Unique bots: {df[df['is_bot']]['user_id'].nunique()}")
    
    # Step 2: Build matches index  
    print("\n[2/4] Building matches index...")
    matches = build_matches_index(df)
    
    # Save matches index
    index_path = os.path.join(OUTPUT_DIR, 'matches_index.json')
    with open(index_path, 'w') as f:
        json.dump(matches, f)
    print(f"  Saved {len(matches)} matches to matches_index.json ({os.path.getsize(index_path) / 1024:.1f} KB)")
    
    # Step 3: Build individual match data files
    print("\n[3/4] Building match timeline data...")
    match_dir = os.path.join(OUTPUT_DIR, 'matches')
    os.makedirs(match_dir, exist_ok=True)
    
    for i, match_id in enumerate(matches.keys()):
        match_data = build_match_data(df, match_id)
        match_path = os.path.join(match_dir, f'{match_id}.json')
        with open(match_path, 'w') as f:
            json.dump(match_data, f)
        if (i+1) % 100 == 0:
            print(f"  Processed {i+1}/{len(matches)} matches...")
    
    print(f"  Processed all {len(matches)} matches")
    
    # Step 4: Build heatmap data
    print("\n[4/4] Building heatmap data...")
    heatmaps = build_heatmap_data(df)
    heatmap_path = os.path.join(OUTPUT_DIR, 'heatmaps.json')
    with open(heatmap_path, 'w') as f:
        json.dump(heatmaps, f)
    print(f"  Saved heatmaps to heatmaps.json ({os.path.getsize(heatmap_path) / 1024:.1f} KB)")
    
    # Summary stats for the frontend
    stats = {
        'total_events': len(df),
        'total_matches': len(matches),
        'total_human_players': int(df[~df['is_bot']]['user_id'].nunique()),
        'total_bots': int(df[df['is_bot']]['user_id'].nunique()),
        'date_range': {'start': 'February 10', 'end': 'February 14'},
        'maps': list(MAP_CONFIG.keys()),
        'days': DAYS,
        'event_types': df['event'].value_counts().to_dict(),
        'matches_by_map': df.groupby('map_id')['match_id_clean'].nunique().to_dict(),
        'matches_by_day': df.groupby('day')['match_id_clean'].nunique().to_dict(),
    }
    stats_path = os.path.join(OUTPUT_DIR, 'stats.json')
    with open(stats_path, 'w') as f:
        json.dump(stats, f, indent=2)
    print(f"\n  Saved stats to stats.json")
    
    print("\n" + "="*60)
    print("Data processing complete!")
    print("="*60)

if __name__ == '__main__':
    main()
