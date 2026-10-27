-- Подложка rundom: Москва из OpenStreetMap в своей схеме (tilemaker).
-- Слои: water, waterway, landcover, landuse, park, building, road, road_name,
-- place, water_name, park_name, poi. Признак run у дороги повторяет правила
-- проходимости генератора (src/core/osm.js, classifyWay): 1 — можно бежать, 0 — закрыто.

node_keys = { "place", "amenity", "drinking_water" }
way_keys = { "highway", "railway", "waterway", "natural", "landuse", "leisure", "building",
  "amenity" }

local PATHLIKE = { pedestrian = true, footway = true, path = true, cycleway = true, track = true, bridleway = true }
local STREET = { living_street = true, residential = true, unclassified = true, service = true, road = true }
local ROADS = { tertiary = true, tertiary_link = true }
local MAIN = { secondary = true, secondary_link = true, primary = true, primary_link = true }
local CLOSED_ACCESS = { no = true, private = true, customers = true, permit = true, delivery = true,
  agricultural = true, forestry = true, military = true }
local UNPAVED = { unpaved = true, compacted = true, fine_gravel = true, gravel = true, dirt = true, earth = true,
  ground = true, grass = true, mud = true, sand = true, woodchips = true, pebblestone = true }

-- класс линии на карте
local DRAW = {
  motorway = "major", motorway_link = "major", trunk = "major", trunk_link = "major",
  primary = "major", primary_link = "major",
  secondary = "mid", secondary_link = "mid", tertiary = "mid", tertiary_link = "mid",
  residential = "minor", unclassified = "minor", living_street = "minor", road = "minor",
  service = "service",
  pedestrian = "path", footway = "path", path = "path", cycleway = "path", track = "path", bridleway = "path",
  steps = "steps"
}
local DRAW_MINZOOM = { major = 8, mid = 10, minor = 12, service = 13, path = 13, steps = 14 }

local LANDCOVER = { wood = "wood", forest = "wood", grass = "grass", meadow = "grass", scrub = "grass",
  heath = "grass", wetland = "grass", farmland = "grass", village_green = "grass", allotments = "grass",
  recreation_ground = "grass", grassland = "grass" }
local LANDUSE = { residential = true, commercial = true, industrial = true, retail = true, railway = true,
  garages = true, construction = true, cemetery = true }
local PARK = { park = true, garden = true, nature_reserve = true }

-- метров на пиксель по масштабу
local function res(z) return 156543 / 2 ^ z end

-- площадь видна с того масштаба, где она больше нескольких пикселей
local function minZoomByArea(from)
  local a = Area()
  for z = from, 13 do
    if a > (res(z) * 3) ^ 2 then MinZoom(z); return end
  end
  MinZoom(14)
end

local function name()
  local n = Find("name:ru")
  if n == "" then n = Find("name") end
  return n
end

local function footYes(foot) return foot == "yes" or foot == "designated" or foot == "permissive" end

-- 1: можно бежать, 0: закрыто для пешехода, nil: бежать нельзя совсем (магистрали)
local function runFlag(hw)
  if not (PATHLIKE[hw] or STREET[hw] or ROADS[hw] or MAIN[hw] or hw == "steps") then return nil end
  local indoor = Find("indoor")
  if indoor == "yes" or indoor == "room" or indoor == "corridor" then return nil end
  local service = Find("service")
  if service == "parking_aisle" or service == "drive-through" then return nil end
  local foot = Find("foot")
  if foot == "no" or foot == "private" or foot == "use_sidepath" then return 0 end
  if not footYes(foot) and CLOSED_ACCESS[Find("access")] then return 0 end
  return 1
end

local function zorder()
  local z = 0
  local layer = tonumber(Find("layer"))
  if layer then z = math.max(-7, math.min(7, layer)) * 10 end
  local b, t = Find("bridge"), Find("tunnel")
  if b ~= "" and b ~= "no" then z = z + 5 elseif t ~= "" and t ~= "no" then z = z - 5 end
  ZOrder(z)
end

local function brunnel()
  local b, t = Find("bridge"), Find("tunnel")
  if b ~= "" and b ~= "no" then return "bridge" end
  if (t ~= "" and t ~= "no") or Find("covered") == "yes" then return "tunnel" end
  return ""
end

local function poiClass(amenity)
  if amenity == "drinking_water" or (amenity == "fountain" and Find("drinking_water") == "yes") then return "drinking_water" end
  if amenity == "fountain" then return "fountain" end
  if amenity == "toilets" then return "toilets" end
  return nil
end

function node_function()
  local place = Find("place")
  if place ~= "" then
    local mz = ({ city = 8, town = 10, village = 11, suburb = 11, quarter = 13, neighbourhood = 14 })[place]
    if mz then
      Layer("place", false)
      Attribute("class", place)
      Attribute("name", name())
      MinZoom(mz)
    end
    return
  end
  local poi = poiClass(Find("amenity"))
  if poi and Find("access") ~= "private" then
    Layer("poi", false)
    Attribute("class", poi)
  end
end

function way_function()
  local hw = Find("highway")
  local railway = Find("railway")
  local waterway = Find("waterway")
  local natural = Find("natural")
  local landuse = Find("landuse")
  local leisure = Find("leisure")
  local amenity = Find("amenity")
  local closed = IsClosed()

  -- дороги и тропы
  local draw = DRAW[hw]
  if draw then
    if Find("area") == "yes" and hw ~= "pedestrian" then return end
    local br = brunnel()
    Layer("road", false)
    Attribute("class", draw)
    if br ~= "" then Attribute("brunnel", br) end
    MinZoom(DRAW_MINZOOM[draw])
    local run = runFlag(hw)
    if run then AttributeInteger("run", run, 12) end
    if Find("lit") == "yes" then AttributeInteger("lit", 1, 13) end
    if UNPAVED[Find("surface")] or (hw == "track" and Find("surface") == "") then AttributeInteger("unpaved", 1, 13) end
    local fw = Find("footway")
    if fw == "crossing" or Find("crossing") ~= "" then AttributeInteger("crossing", 1, 14)
    elseif fw == "sidewalk" then AttributeInteger("sidewalk", 1, 14) end
    zorder()
    local n = name()
    if n ~= "" and draw ~= "path" and draw ~= "steps" then
      Layer("road_name", false)
      Attribute("class", draw)
      Attribute("name", n)
      MinZoom(draw == "major" and 13 or 14)
    end
    return
  end

  if railway == "rail" or railway == "light_rail" or railway == "narrow_gauge" or railway == "tram" then
    if Find("service") ~= "" then return end
    local br = brunnel()
    Layer("road", false)
    Attribute("class", railway == "tram" and "tram" or "rail")
    if br ~= "" then Attribute("brunnel", br) end
    MinZoom(railway == "tram" and 13 or 10)
    zorder()
    return
  end

  -- вода
  if closed and (natural == "water" or waterway == "riverbank" or landuse == "reservoir" or landuse == "basin") then
    if Find("covered") == "yes" or Find("tunnel") == "culvert" then return end
    Layer("water", true)
    minZoomByArea(8)
    local n = name()
    if n ~= "" and Find("water") ~= "basin" then
      LayerAsCentroid("water_name")
      Attribute("name", n)
      minZoomByArea(12)
    end
    return
  end
  if waterway == "river" or waterway == "canal" or waterway == "stream" then
    if brunnel() == "tunnel" then return end
    Layer("waterway", false)
    Attribute("class", waterway)
    MinZoom(waterway == "stream" and 13 or 10)
    local n = name()
    if n ~= "" and waterway ~= "stream" then
      Layer("water_name", false)
      Attribute("name", n)
      MinZoom(13)
    end
    return
  end

  if not closed then return end

  -- парки — отдельно от покрытия земли: у них есть имя
  if PARK[leisure] then
    Layer("park", true)
    minZoomByArea(8)
    local n = name()
    if n ~= "" then
      LayerAsCentroid("park_name")
      Attribute("name", n)
      minZoomByArea(12)
    end
  end

  local lc = LANDCOVER[landuse] or LANDCOVER[natural] or LANDCOVER[leisure]
  if lc then
    Layer("landcover", true)
    Attribute("class", lc)
    minZoomByArea(8)
  elseif LANDUSE[landuse] then
    Layer("landuse", true)
    Attribute("class", landuse)
    minZoomByArea(10)
  end

  local building = Find("building")
  if building ~= "" and building ~= "no" then
    Layer("building", true)
    MinZoom(13)
  end

  local poi = poiClass(amenity)
  if poi and Find("access") ~= "private" then
    LayerAsCentroid("poi")
    Attribute("class", poi)
  end
end
