# Virtual background image prompts

Thirteen self-contained prompts for generating virtual-background images that
sit well behind a segmented person in the meeting stage. Each block can be
pasted into an image generator on its own — nothing here depends on another
prompt or on this preamble.

## Why the prompts look the way they do

The compositor (`src/net/background-compositor.js`) cuts the person out
with a 256×144 mask, snaps the edge to the camera frame with a joint
bilateral upsample, and then **screens a rim of the background onto the
subject** (light wrap, strength 0.4 for image backgrounds). That gives a
few rules for the image behind the person — none of them require the
image to be dark or blurry:

- **Sharp scene, simple centre.** The image should be a crisp, in-focus
  photograph — laptop cameras have deep depth of field, so a sharp room
  reads as real and a bokeh wash reads as an effect. The one concession:
  the person occupies the centre and lower half of the frame, and the
  mask edge is feathered by a few pixels, so *very fine* detail right on
  the outline (thin shelf lines, small repeating patterns, tiny text-like
  texture) can make the edge read as a cut-out. Keep the centre made of
  large, clean shapes and put the intricate detail at the sides and top.
- **No blown-out light source directly behind the head.** Light wrap
  screens the background onto the subject's outline — a lamp, sun or
  glowing window centred at head height tints and blows out skin and
  hair. Bright *colour* is fine; pure-white hot spots in the centre are
  not. Windows and lamps go to the sides and top.
- **Colour distinct from skin and hair.** Keep the centre off warm
  beige/peach and off near-black-brown, so the segmenter's confidence
  band lands on a real colour edge. Greens, teals, blues, violets and
  cool greys all work well.
- **Keep the theme.** The bundled presets are rich, clean jewel tones —
  indigo/brand blue `#0010d7`–`#aab4ff`, dusk amber `#ffb37a`, forest
  `#1f5a3d`–`#77b98a`, ocean `#12718a`–`#57d1d8`, lavender
  `#7a62a8`–`#d3c3ef`, warm studio grey `#78716c`–`#a8a29e`. Real scenes
  should feel like the same family: colourful, inviting, mid-tone,
  well-lit — not gloomy, not high-key white either.

Format for all thirteen: **16:9 landscape**, at least **1920×1080** (the
stage renders at 1280×720 and cover-fits the image, so a little bleed on
every side is safe to crop). Photorealistic, sharp, no people, no faces,
no readable text or logos, no watermark. If a tool cannot do 16:9
exactly, generate the nearest landscape ratio (e.g. 1792×1024) and crop
to 16:9 keeping the centre.

---

## 1. Sunlit forest (nature)

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like a landscape photograph. A lush green forest on a
bright, clear morning: tall trunks and layered foliage at the left and
right edges, a bright canopy across the top with warm sunlight filtering
through, and a soft carpet of ferns and moss low in the frame. Rich,
saturated, healthy colour — vivid leaf green, emerald and spring green
(around #1f5a3d through #3f8f5f to #77b98a) with golden highlights in the
upper corners. Composition: the centre of the frame, from waist to above
head height, is a simple, open clearing of even mid-tone green foliage
and soft shade — no trunks, branches, bright sky gaps or sunbeams
directly behind where a person's head and shoulders would be; the
intricate leaves and light live at the edges and top. Cheerful, airy,
natural photographic depth. Empty scene: no people, animals, text, signs
or watermark.
Avoid: blur or bokeh, fog, dark or gloomy tones, desaturated colour, a
bright white sky patch or sunburst behind the head, brown/beige dominance,
a tree trunk running through the centre.
```

## 2. Turquoise lake and mountains (nature)

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like a landscape photograph. A calm alpine lake on a
bright clear day, seen from the shore at eye level. The lower two-thirds
of the frame is smooth, glassy turquoise-teal water (around #12718a
through #2fb3c9 to #57d1d8) with only the gentlest ripples — a clean,
even expanse with no rocks, reeds, boats or mirror reflections that would
sit behind a person. Crisp green mountain slopes with pine forest rise at
the left and right, and a band of clear blue sky runs across the top with
a few soft white clouds near the top corners. The sun is out of frame —
bright, even daylight with no glare, no sun disk, no blinding highlight
anywhere near the centre. Vivid but natural colour, fresh and optimistic
mood, natural photographic depth. Empty scene: no people, boats, birds,
text or watermark.
Avoid: blur or bokeh, dusk or night, muted or grey colour, sun glare on
the water, sharp foreground rocks, a bright white sky patch directly
behind the head.
```

## 3. Bright home library bookshelf

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like an interior photograph. A wall of built-in
bookshelves in a bright, welcoming study, photographed straight-on.
Shelving in pale oak or painted a soft sage green, filled with books in a
lively but harmonious mix of teal, cobalt, mustard, coral, violet and
cream — spines visible but with no readable titles — plus a few small
potted plants, a globe and a brass object for warmth. Daylight from a
window off to the left, bright and even, no visible window in frame.
Composition: the fully stocked shelves occupy the left and right thirds;
the centre section of the unit, between shoulder and head height, is a
calmer zone — one wide, deep shelf holding just two or three large books
laid flat and a trailing plant, backed by a smooth painted panel — so no
dense rows of spines or thin shelf edges sit directly behind a person's
outline. Cheerful, warm, mid-tone brightness, gentle contrast. Empty
room: no people, no legible text, no watermark.
Avoid: blur or bokeh, dark wood and dim lighting, pure white books or a
white wall panel in the middle, dense thin spines or ladder-like shelf
lines running through the centre.
```

## 4. Sunny plant-filled café

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like an interior photograph. The interior of a bright,
friendly café in the late morning, seen from a seated position. Walls
painted a clean teal-green (around #12718a to #2f9f9a), light wood
tables and bentwood chairs along the left and right, terracotta pots
with trailing plants on high shelves near the ceiling, pendant lamps
switched off. Big windows sit at the far left and right edges, pouring
in soft daylight — no window directly behind the centre. Composition: the
centre and lower half of the frame is a large, even stretch of the teal
wall above a simple wooden bench, so nothing detailed sits behind a
person; the chairs, plants and shelves frame it from the sides and top.
Fresh, welcoming, colourful, mid-tone brightness with gentle contrast;
greens, teals and warm wood in balance. Empty café: no people, no cups in
the foreground, no menus, chalkboards or readable text, no watermark.
Avoid: blur or bokeh, dim moody lighting, a bright window or glowing lamp
behind the head, busy tile or wallpaper patterns in the centre, orange
colour cast.
```

## 5. Daylight loft office

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like an architectural interior photograph. A modern,
airy loft office on a sunny day: a feature wall painted a confident
cornflower / periwinkle blue (around #3a4fff softened towards #aab4ff),
pale polished concrete floor, a light oak desk with a closed notebook at
the far right, and a tall leafy fiddle-leaf fig at the far left. Large
black steel-framed windows are at the very edges or out of frame, so
daylight is bright and even but no window pane appears behind the
centre. Composition: the middle and lower centre is a clean, evenly lit
expanse of the blue wall with no fixtures, art, shelves or lines at head
and shoulder height; the desk, plant, window frames and a high exposed
beam frame it from the outer thirds and top. Crisp, optimistic,
contemporary, mid-tone brightness, gentle contrast. Empty office: no
people, no screens turned on, no text, no watermark.
Avoid: blur or bokeh, dark or dusk lighting, grey or desaturated walls, a
glowing window or lens flare behind the head, brick texture or vertical
lines through the centre, white walls.
```

## 6. Lavender living room, morning light

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like an interior photograph. A calm, cheerful living
room in soft morning light. Walls painted a fresh lavender-violet (around
#7a62a8 lifted towards #b39ddb), a low linen sofa in a lighter lilac-grey
along the bottom of the frame, a light wood side table with a small vase
of eucalyptus at one side, and a large indoor plant with glossy green
leaves at the far left or right edge. Daylight comes from a window
off-frame to one side, bright and diffuse — no visible window or lamp
behind the centre. Composition: the centre of the frame from waist to
above head height is a smooth, uniformly coloured wall with no art,
shelving, switches or edges, so nothing sits behind a person's outline;
the furniture and plant frame it from the sides and bottom. Airy, warm,
inviting, mid-tone brightness, gentle contrast, colours clean and
slightly saturated. Empty room: no people, pets, screens, readable text
or watermark.
Avoid: blur or bokeh, dim evening lighting, grey or muddy tones, white or
cream walls, picture frames in the centre, a bright lamp or window behind
the head, beige/peach tones near skin colour.
```

## 7. Golden-hour city skyline through a window

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like a photograph from a high-rise. Looking out from a
bright, minimal room through a single large floor-to-ceiling pane of
clean glass at a city skyline at golden hour. The sky is a warm gradient
from soft apricot and rose near the horizon up into clear violet-blue
(around #ffb37a at the horizon band rising through #6e2a4f to #3a4fff),
the sun itself out of frame. Crisp skyscraper silhouettes and detail
occupy the upper third and the left and right edges. Composition: the
centre and lower half of the frame is a calm, even area — the smooth
warm-violet sky above a low, distant, uniformly blue-grey band of city —
with no bright lights, tall spires, sharp edges or window mullions
behind where a person would sit. Rich, glowing, optimistic colour,
mid-tone brightness, gentle contrast. Empty scene: no people, no
signage, no readable text, no watermark.
Avoid: blur or bokeh, night or gloom, desaturated grey, the sun disk or a
blinding white patch behind the head, window frames or a spire through
the centre, lens flare.
```

## 8. Warm painted studio wall (studio)

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like an interior photograph. A minimalist, sunlit
studio corner: a smooth painted wall in a rich sage / eucalyptus green
(around #5f8f7a to #8fb8a2) with very subtle tonal variation — no visible
texture, hard lines or seams. Warm daylight from a large window out of
frame to the upper left produces a broad, gentle gradient across the
wall (a little brighter top-left, a little deeper bottom-right) and one
crisp, soft-edged shadow of a tall potted olive tree that stands at the
far right edge, its leaves in focus. A small light-oak stool and a
folded linen throw sit at the far left edge. Composition: the centre of
the frame, from waist to above head height, is a smooth, even mid-tone
green with nothing on it; the plant, stool and shadow frame it from the
sides. Clean, fresh, calm and cheerful; mid-tone brightness, never dim
or gloomy, never high-key white. Empty studio: no people, furniture in
the centre, text, or watermark.
Avoid: blur or bokeh, grey or muddy colour, dark lighting, a bright hot
spot at head height, visible wall texture in the centre, beige/peach
tones, plant leaves crossing the middle.
```

## 9. Botanical conservatory (indoor nature)

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like an interior photograph. Inside a Victorian glass
conservatory on a bright day: white-painted iron ribs and glass panes
arching across the top of the frame, tall palms, monstera and banana
leaves crowding in from the left and right, ferns along the bottom. Rich
saturated greens (around #1f5a3d through #3f8f5f to #77b98a) with a few
tropical accents — a magenta bromeliad, a bird-of-paradise — tucked at the
edges. Daylight is bright and diffuse through the glass; the sun is not
visible and no pane directly behind the centre is blown out. Composition:
the centre of the frame, from waist to above head height, is a calm,
even backdrop of large, smooth, overlapping mid-green leaves with no
thin stems, iron ribs, bright sky gaps or flowers behind where a person
would sit; the architecture and exotic detail frame it from the top and
sides. Lush, fresh, cheerful, natural photographic depth. Empty
conservatory: no people, no signs or labels, no watermark.
Avoid: blur or bokeh, dim or grey light, a white glare panel behind the
head, tiny busy foliage or thin stems crossing the centre, brown soil
dominating, beige/peach tones.
```

## 10. Art gallery with a deep blue wall

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like an architectural interior photograph. A quiet
contemporary art gallery: a long wall painted a deep, saturated ultramarine
(around #0010d7 softened towards #2733e6 and #3a4fff), pale wide-plank
oak floor, and a bright, even skylight wash from above with no visible
fixtures. Two large colourful abstract canvases hang well off to the far
left and far right — bold blocks of coral, mustard, teal and violet — and
a low white plinth with a small sculpture stands at the far right edge.
Composition: the centre of the frame, from waist to above head height, is
a clean, uninterrupted expanse of the blue wall with no artwork, labels,
lights or edges, so nothing sits behind a person's outline; the art and
plinth frame it from the sides. Crisp, confident, gallery-bright but not
white, mid-tone brightness, gentle contrast. Empty gallery: no people,
no readable wall text or labels, no watermark.
Avoid: blur or bokeh, white or grey walls, a canvas or spotlight in the
centre, dim moody lighting, desaturated colour, picture frames at head
height.
```

## 11. Coral reef, open water (underwater nature)

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like an underwater photograph. A sunlit tropical coral
reef seen from a few metres down: vivid coral heads, purple and orange
sea fans, and small schools of bright yellow and blue fish crowd the left
and right edges and the very bottom of the frame. The water is clear,
glowing turquoise-to-deep-blue (around #57d1d8 near the surface down
through #2fb3c9 and #12718a to #0a4a63), with soft light rays and
shimmer only across the top edge. Composition: the centre of the frame,
from waist to above head height, is calm open water — a smooth, even
gradient of clear blue with no coral, fish, bubbles or bright surface
glare behind where a person would sit; all the reef life frames it from
the sides and bottom. Bright, vibrant, joyful colour, natural
photographic depth, gentle contrast. Empty scene: no divers, no
people, no text, no watermark.
Avoid: blur or bokeh, murky or dark green water, a blinding white
surface glare behind the head, fish or bubbles crossing the centre,
sandy beige bottom dominating, low visibility.
```

## 12. Lavender field at golden hour (nature)

```
Photorealistic virtual background for a video call, 16:9 landscape, 1920×1080,
sharp and in focus like a landscape photograph. A lavender farm in the
south of France in the warm light of early evening. The lower half of the
frame is a dense, even carpet of blooming lavender in rich violet and
purple (around #7a62a8 through #8f7bc0 to #b39ddb), shot from low and
straight-on so the rows read as one soft-textured mass rather than
converging lines. Along the top edge, a line of dark green cypress trees
at the left and a stone farmhouse with a terracotta roof at the far
right sit under a clear sky that grades from soft apricot at the horizon
(around #ffb37a) up into pale blue; the sun is out of frame, no glare or
sun disk. Composition: the centre of the frame, from waist to above head
height, is calm — the smooth violet field below and an even, uncluttered
band of sky above with no tree, building or bright patch directly behind
where a person would sit. Warm, glowing, romantic, saturated colour,
gentle contrast, natural photographic depth. Empty scene: no people, no
vehicles, no text, no watermark.
Avoid: blur or bokeh, grey or overcast light, strong converging rows
pointing at the centre, a white sky patch or sun behind the head,
brown/beige dominance, dusk darkness.
```

## 13. Matte 3D abstract in the brand palette (abstract)

```
Clean 3D-rendered abstract virtual background for a video call, 16:9
landscape, 1920×1080, sharp and crisp, matte materials, soft studio
lighting, no photograph. A calm composition of large smooth geometric
forms — a few oversized spheres, a rounded arch, a tilted torus, a
softly bevelled slab — arranged around the edges and top of the frame,
in a harmonious palette taken from these colours: deep brand blue
#0010d7, cornflower #3a4fff, periwinkle #aab4ff, teal #2fb3c9, aqua
#57d1d8, lavender #b39ddb and a single warm amber accent #ffb37a. The
backdrop behind them is a smooth, gently lit gradient from cornflower
blue at the top to a deeper indigo-blue at the bottom. Composition: the
centre of the frame, from waist to above head height, is an empty,
uninterrupted area of the smooth blue gradient with no shapes, edges,
shadows or highlights, so nothing sits behind a person's outline; the
forms frame it from the sides and top and cast soft, gentle shadows.
Matte, non-reflective surfaces, no glossy specular hot spots, no white
areas, no text. Modern, friendly, optimistic, mid-tone brightness.
Avoid: blur or bokeh, glossy or chrome materials, bright white or
near-white highlights, tiny scattered particles, shapes crossing the
centre, dark or gloomy tones, gradients that go to black.
```

---

## Checking a generated image before adding it

1. Squint at it: the centre and lower half should be a calm area of
   large, clean shapes; intricate detail should live at the edges and
   top. The image itself should be sharp — if it looks blurred, regenerate.
2. Nothing directly behind the head-and-shoulders zone should be a
   blown-out white/near-white highlight — light wrap paints it onto the
   subject's rim. Bright *colour* there is fine.
3. Nothing in the centre should be a warm beige/peach/brown close to skin
   or hair colour.
4. It should look like a sibling of the bundled presets: rich, clean
   colour, inviting, neither gloomy nor washed-out.
5. Re-encode to 1280×720 WebP (`magick in.png -resize 1280x720^ -gravity
   center -extent 1280x720 -strip -quality 82 public/backgrounds/<id>.webp`)
   and add `{ id, label }` to `PRESET_BACKGROUNDS` in `src/lib/backgrounds.js`.
