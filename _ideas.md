For your website, I’d start with a simple “Region search” tab:
1. Draw a polygon on the map, or draw a rectangle for a quicker search.
2. Click Search region—don’t query while drawing.
3. Search measurements across all databases.
4. Show matching collections with their database, measurement counts, and date range.
5. Select a result to explore its measurements.
Optional features later:
- Filter by measurement type, technology, operator, and time.
- Filter by indoor/outdoor and mobility once those tags exist.
- Export matching measurements as CSV.
- Share a URL that restores the polygon and filters.
- Compare measurements from different collections within the polygon.
For speed, I’d keep the work on the server:
- First eliminate partitions whose geographic bounds don’t overlap the polygon.
- Then filter candidate rows by the polygon’s bounding rectangle.
- Finally check which coordinates are actually inside the polygon.
- Return summary results and a limited number of map points—not every matching row.
This would require adding geographic bounds to the import/catalog workflow. Rows without GPS cannot participate in spatial searches, but would remain in the database.
One important choice: find collections that intersect the polygon, or return only measurements inside it? I recommend both: list matching collections, but calculate search counts and summaries using only their measurements inside the polygon.
My suggested first version: polygon/rectangle drawing → explicit search → matching collections and counts → limited map preview. Leave export, sharing, and advanced filters for later.