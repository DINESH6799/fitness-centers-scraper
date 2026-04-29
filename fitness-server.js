const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const INDIAN_CITIES = require('./cities');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || process.env.FITNESS_PORT || 3002;
const GRID_SPACING_KM = 9;
const SEARCH_RADIUS_METERS = 5000;
const MAX_NEARBY_RESULTS = 20;
const TEXT_SEARCH_PAGE_SIZE = 20;
const TEXT_SEARCH_PAGE_LIMIT = 3;
const REQUEST_DELAY_MS = 200;
const PAGE_TOKEN_DELAY_MS = 2000;
const MAX_RETRIES = 3;
const SUBDIVISION_RADIUS_METERS = 2500;
const MAX_NEARBY_SUBDIVISIONS = 4;
const KEYWORD_RECALL_RADIUS_METERS = 3000;
const POINT_KEYWORD_QUERIES = ['gym', 'fitness center', 'fitness studio', 'health club'];
const FITNESS_SESSIONS_TABLE = 'fitness_scraping_sessions';

const FITNESS_FIELD_MASK = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.location',
    'places.primaryType',
    'places.types',
    'places.businessStatus',
    'places.googleMapsUri',
    'places.rating',
    'places.userRatingCount'
].join(',');

const COVERAGE_MODES = {
    strict: {
        key: 'strict',
        label: 'Strict Gyms',
        description: 'Gyms and fitness centers only',
        includedTypes: ['gym', 'fitness_center'],
        searchNearbyTypes: ['gym', 'fitness_center', 'sports_activity_location', 'wellness_center', 'yoga_studio'],
        fallbackQueries: [
            { textQuery: 'gym in {{city}}' },
            { textQuery: 'fitness center in {{city}}' },
            { textQuery: 'fitness studio in {{city}}' },
            { textQuery: 'health club in {{city}}' }
        ]
    },
    expanded: {
        key: 'expanded',
        label: 'Expanded Fitness',
        description: 'Gyms, fitness centers, sports clubs, sports complexes, and sports activity locations',
        includedTypes: ['gym', 'fitness_center', 'sports_club', 'sports_complex', 'sports_activity_location'],
        searchNearbyTypes: ['gym', 'fitness_center', 'sports_club', 'sports_complex', 'sports_activity_location', 'wellness_center', 'yoga_studio'],
        fallbackQueries: [
            { textQuery: 'gym in {{city}}' },
            { textQuery: 'fitness center in {{city}}' },
            { textQuery: 'fitness studio in {{city}}' },
            { textQuery: 'health club in {{city}}' },
            { textQuery: 'sports club in {{city}}' }
        ]
    }
};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const sessions = new Map();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCoverageMode(modeKey) {
    return COVERAGE_MODES[modeKey] || COVERAGE_MODES.strict;
}

function buildHeaders(apiKey) {
    return {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FITNESS_FIELD_MASK
    };
}

function getGoogleErrorMessage(error) {
    return error.response?.data?.error?.message || error.message || 'Google Places request failed';
}

function isRetryableGoogleError(error) {
    const status = error.response?.status;
    return status === 429 || status === 500 || status === 503;
}

async function runGoogleRequest(requestFn) {
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
        try {
            return await requestFn();
        } catch (error) {
            attempt += 1;

            if (!isRetryableGoogleError(error) || attempt >= MAX_RETRIES) {
                throw error;
            }

            await sleep(Math.pow(2, attempt) * 500);
        }
    }

    throw new Error('Google Places request failed after retries');
}

function generateGrid(bounds, spacingKm, centerLat) {
    const latDegPerKm = 1 / 110.574;
    const lngDegPerKm = 1 / (111.320 * Math.cos(centerLat * Math.PI / 180));

    const latStep = spacingKm * latDegPerKm;
    const lngStep = spacingKm * lngDegPerKm;

    const grid = [];
    let lat = bounds.min_lat;
    while (lat <= bounds.max_lat) {
        let lng = bounds.min_lng;
        while (lng <= bounds.max_lng) {
            grid.push({ lat, lng });
            lng += lngStep;
        }
        lat += latStep;
    }
    return grid;
}

function getFallbackQueryCount(mode) {
    return getCoverageMode(mode).fallbackQueries.length;
}

function serializeSession(session) {
    return {
        session_id: session.session_id,
        city_names: session.city_names,
        mode_key: session.mode_key,
        mode_label: session.mode_label,
        status: session.status,
        progress: session.progress,
        total_operations: session.total_operations,
        completed_operations: session.completed_operations,
        request_count: session.request_count,
        total_results: session.total_results,
        results: session.results || [],
        error_message: session.error_message || '',
        created_at: session.created_at,
        updated_at: session.updated_at
    };
}

function deserializeSession(row) {
    if (!row) {
        return null;
    }

    return {
        session_id: row.session_id,
        city_names: row.city_names || [],
        mode_key: row.mode_key,
        mode_label: row.mode_label,
        status: row.status,
        progress: row.progress || {
            phase: '',
            current: 0,
            total: 0,
            percentage: 0,
            currentLabel: ''
        },
        total_operations: row.total_operations || 0,
        completed_operations: row.completed_operations || 0,
        request_count: row.request_count || 0,
        total_results: row.total_results || 0,
        results: row.results || [],
        error_message: row.error_message || '',
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

async function persistSessionSnapshot(session, includeResults = false) {
    if (!supabase || !session) {
        return;
    }

    const payload = serializeSession(session);
    if (!includeResults) {
        payload.results = [];
    }

    try {
        await supabase
            .from(FITNESS_SESSIONS_TABLE)
            .upsert(payload, { onConflict: 'session_id' });
    } catch (error) {
        console.warn('Supabase session persistence failed:', error.message);
    }
}

async function loadSession(sessionId) {
    if (sessions.has(sessionId)) {
        return sessions.get(sessionId);
    }

    if (!supabase) {
        return null;
    }

    try {
        const { data, error } = await supabase
            .from(FITNESS_SESSIONS_TABLE)
            .select('*')
            .eq('session_id', sessionId)
            .maybeSingle();

        if (error || !data) {
            return null;
        }

        const session = deserializeSession(data);
        if (session && (session.status === 'starting' || session.status === 'in_progress')) {
            session.status = 'failed';
            session.error_message = session.error_message || 'Scrape interrupted by server restart. Please rerun the job.';
            session.updated_at = new Date().toISOString();
            await persistSessionSnapshot(session, true);
        }
        sessions.set(sessionId, session);
        return session;
    } catch (error) {
        console.warn('Supabase session load failed:', error.message);
        return null;
    }
}

function normalizePlace(place, source) {
    return {
        place_id: place.id || '',
        city: source.cityName || '',
        name: place.displayName?.text || '',
        address: place.formattedAddress || '',
        latitude: place.location?.latitude ?? null,
        longitude: place.location?.longitude ?? null,
        primary_type: place.primaryType || '',
        types: Array.isArray(place.types) ? place.types : [],
        business_status: place.businessStatus || '',
        google_maps_uri: place.googleMapsUri || '',
        rating: place.rating ?? '',
        user_rating_count: place.userRatingCount ?? '',
        source: source.label
    };
}

function mergePlaces(existing, incoming) {
    const sourceSet = new Set(String(existing.source || '').split('|').filter(Boolean));
    String(incoming.source || '').split('|').filter(Boolean).forEach((source) => sourceSet.add(source));

    const typeSet = new Set([...(existing.types || []), ...(incoming.types || [])].filter(Boolean));
    const citySet = new Set(String(existing.city || '').split('|').filter(Boolean));
    String(incoming.city || '').split('|').filter(Boolean).forEach((city) => citySet.add(city));

    return {
        ...existing,
        city: Array.from(citySet).join('|'),
        address: existing.address || incoming.address,
        latitude: existing.latitude ?? incoming.latitude,
        longitude: existing.longitude ?? incoming.longitude,
        primary_type: existing.primary_type || incoming.primary_type,
        types: Array.from(typeSet),
        business_status: existing.business_status || incoming.business_status,
        google_maps_uri: existing.google_maps_uri || incoming.google_maps_uri,
        rating: existing.rating || incoming.rating,
        user_rating_count: existing.user_rating_count || incoming.user_rating_count,
        source: Array.from(sourceSet).join('|')
    };
}

function offsetPoint(point, northKm, eastKm) {
    const latOffset = northKm / 110.574;
    const lngOffset = eastKm / (111.320 * Math.cos(point.lat * Math.PI / 180));

    return {
        ...point,
        lat: point.lat + latOffset,
        lng: point.lng + lngOffset
    };
}

function buildSubdivisionPoints(point, radiusMeters) {
    const offsetKm = Math.max(1, (radiusMeters / 1000) * 0.45);

    return [
        offsetPoint(point, offsetKm, offsetKm),
        offsetPoint(point, offsetKm, -offsetKm),
        offsetPoint(point, -offsetKm, offsetKm),
        offsetPoint(point, -offsetKm, -offsetKm)
    ];
}

async function searchNearbyByTypes(point, includedTypes, apiKey, radiusMeters = SEARCH_RADIUS_METERS) {
    const response = await runGoogleRequest(() => axios.post(
        'https://places.googleapis.com/v1/places:searchNearby',
        {
            includedTypes,
            maxResultCount: MAX_NEARBY_RESULTS,
            rankPreference: 'DISTANCE',
            locationRestriction: {
                circle: {
                    center: {
                        latitude: point.lat,
                        longitude: point.lng
                    },
                    radius: radiusMeters
                }
            }
        },
        {
            headers: buildHeaders(apiKey),
            timeout: 20000
        }
    ));

    return {
        requests: 1,
        saturated: (response.data.places || []).length >= MAX_NEARBY_RESULTS,
        places: (response.data.places || []).map((place) => normalizePlace(place, { label: 'nearby_type', cityName: point.cityName }))
    };
}

async function searchTextFallback(cityName, bounds, apiKey, fallbackQuery) {
    const places = [];
    let requests = 0;
    let pageToken = null;
    let page = 0;

    const baseBody = {
        textQuery: fallbackQuery.textQuery.replace('{{city}}', cityName),
        pageSize: TEXT_SEARCH_PAGE_SIZE,
        rankPreference: 'DISTANCE',
        regionCode: 'IN',
        locationRestriction: {
            rectangle: {
                low: {
                    latitude: bounds.min_lat,
                    longitude: bounds.min_lng
                },
                high: {
                    latitude: bounds.max_lat,
                    longitude: bounds.max_lng
                }
            }
        }
    };

    if (fallbackQuery.includedType) {
        baseBody.includedType = fallbackQuery.includedType;
        baseBody.strictTypeFiltering = fallbackQuery.strictTypeFiltering !== false;
    }

    do {
        const body = pageToken ? { ...baseBody, pageToken } : baseBody;
        const response = await runGoogleRequest(() => axios.post(
            'https://places.googleapis.com/v1/places:searchText',
            body,
            {
                headers: buildHeaders(apiKey),
                timeout: 20000
            }
        ));

        requests += 1;
        page += 1;
        const searchLabel = fallbackQuery.includedType
            ? `text_search:${fallbackQuery.includedType}`
            : `text_search:${fallbackQuery.textQuery.replace('{{city}}', cityName)}`;
        places.push(...(response.data.places || []).map((place) => normalizePlace(place, { label: searchLabel, cityName })));
        pageToken = response.data.nextPageToken || null;

        if (pageToken && page < TEXT_SEARCH_PAGE_LIMIT) {
            await sleep(PAGE_TOKEN_DELAY_MS);
        }
    } while (pageToken && page < TEXT_SEARCH_PAGE_LIMIT);

    return { requests, places };
}

async function searchKeywordAroundPoint(point, keyword, apiKey, radiusMeters = KEYWORD_RECALL_RADIUS_METERS) {
    const response = await runGoogleRequest(() => axios.post(
        'https://places.googleapis.com/v1/places:searchText',
        {
            textQuery: keyword,
            pageSize: TEXT_SEARCH_PAGE_SIZE,
            rankPreference: 'DISTANCE',
            regionCode: 'IN',
            locationBias: {
                circle: {
                    center: {
                        latitude: point.lat,
                        longitude: point.lng
                    },
                    radius: radiusMeters
                }
            }
        },
        {
            headers: buildHeaders(apiKey),
            timeout: 20000
        }
    ));

    return {
        requests: 1,
        places: (response.data.places || []).map((place) => normalizePlace(place, {
            label: `keyword_recall:${keyword}`,
            cityName: point.cityName
        }))
    };
}

function estimateMaxRequests(cityName, modeKey) {
    const city = INDIAN_CITIES[cityName];
    if (!city) {
        return { gridPoints: 0, minRequests: 0, maxRequests: 0 };
    }

    const gridPoints = generateGrid(city.bounds, GRID_SPACING_KM, city.center[0]).length;
    const fallbackCount = getFallbackQueryCount(modeKey);

    return {
        gridPoints,
        minRequests: gridPoints + fallbackCount,
        maxRequests: (gridPoints * (1 + MAX_NEARBY_SUBDIVISIONS + POINT_KEYWORD_QUERIES.length)) + (fallbackCount * TEXT_SEARCH_PAGE_LIMIT)
    };
}

function estimateCombinedRequests(cityNames, modeKey) {
    return cityNames.reduce((acc, cityName) => {
        const estimate = estimateMaxRequests(cityName, modeKey);
        acc.gridPoints += estimate.gridPoints;
        acc.minRequests += estimate.minRequests;
        acc.maxRequests += estimate.maxRequests;
        return acc;
    }, { gridPoints: 0, minRequests: 0, maxRequests: 0 });
}

async function runScrapeInBackground(sessionId, cityNames, modeKey, apiKey) {
    const session = sessions.get(sessionId);
    if (!session) {
        return;
    }

    const mode = getCoverageMode(modeKey);
    const estimate = estimateCombinedRequests(cityNames, modeKey);

    session.status = 'in_progress';
    session.total_operations = estimate.maxRequests;
    session.updated_at = new Date().toISOString();
    await persistSessionSnapshot(session);

    try {
        const dedupedPlaces = new Map();
        let completedOperations = 0;
        let completedCities = 0;

        for (const cityName of cityNames) {
            const city = INDIAN_CITIES[cityName];
            const grid = generateGrid(city.bounds, GRID_SPACING_KM, city.center[0]).map((point) => ({
                ...point,
                cityName
            }));

            for (let index = 0; index < grid.length; index += 1) {
                const point = grid[index];
                const nearbyResult = await searchNearbyByTypes(point, mode.searchNearbyTypes || mode.includedTypes, apiKey);

                nearbyResult.places.forEach((place) => {
                    if (!place.place_id) {
                        return;
                    }
                    const existing = dedupedPlaces.get(place.place_id);
                    dedupedPlaces.set(place.place_id, existing ? mergePlaces(existing, place) : place);
                });

                completedOperations += nearbyResult.requests;
                session.completed_operations = completedOperations;
                session.request_count = completedOperations;
                session.total_results = dedupedPlaces.size;
                session.progress = {
                    phase: 'Nearby type search',
                    current: completedOperations,
                    total: estimate.maxRequests,
                    percentage: Math.min(99, Math.round((completedOperations / estimate.maxRequests) * 100)),
                    currentLabel: `${cityName}: grid point ${index + 1} of ${grid.length}`
                };
                session.updated_at = new Date().toISOString();

                await sleep(REQUEST_DELAY_MS);

                if (nearbyResult.saturated) {
                    const subdivisionPoints = buildSubdivisionPoints(point, SEARCH_RADIUS_METERS);

                    for (let subIndex = 0; subIndex < subdivisionPoints.length; subIndex += 1) {
                        const subPoint = subdivisionPoints[subIndex];
                        const subNearbyResult = await searchNearbyByTypes(
                            subPoint,
                            mode.searchNearbyTypes || mode.includedTypes,
                            apiKey,
                            SUBDIVISION_RADIUS_METERS
                        );

                        subNearbyResult.places.forEach((place) => {
                            if (!place.place_id) {
                                return;
                            }
                            const existing = dedupedPlaces.get(place.place_id);
                            dedupedPlaces.set(place.place_id, existing ? mergePlaces(existing, place) : place);
                        });

                        completedOperations += subNearbyResult.requests;
                        session.completed_operations = Math.min(estimate.maxRequests, completedOperations);
                        session.request_count = completedOperations;
                        session.total_results = dedupedPlaces.size;
                        session.progress = {
                            phase: 'Dense area refinement',
                            current: Math.min(estimate.maxRequests, completedOperations),
                            total: estimate.maxRequests,
                            percentage: Math.min(99, Math.round((completedOperations / estimate.maxRequests) * 100)),
                            currentLabel: `${cityName}: refining dense cell ${index + 1} (${subIndex + 1}/${subdivisionPoints.length})`
                        };
                        session.updated_at = new Date().toISOString();

                        await sleep(REQUEST_DELAY_MS);
                    }

                    for (const keyword of POINT_KEYWORD_QUERIES) {
                        const keywordResult = await searchKeywordAroundPoint(point, keyword, apiKey);

                        keywordResult.places.forEach((place) => {
                            if (!place.place_id) {
                                return;
                            }
                            const existing = dedupedPlaces.get(place.place_id);
                            dedupedPlaces.set(place.place_id, existing ? mergePlaces(existing, place) : place);
                        });

                        completedOperations += keywordResult.requests;
                        session.completed_operations = Math.min(estimate.maxRequests, completedOperations);
                        session.request_count = completedOperations;
                        session.total_results = dedupedPlaces.size;
                        session.progress = {
                            phase: 'Keyword recall search',
                            current: Math.min(estimate.maxRequests, completedOperations),
                            total: estimate.maxRequests,
                            percentage: Math.min(99, Math.round((completedOperations / estimate.maxRequests) * 100)),
                            currentLabel: `${cityName}: "${keyword}" around dense cell ${index + 1}`
                        };
                        session.updated_at = new Date().toISOString();

                        await sleep(REQUEST_DELAY_MS);
                    }

                    await persistSessionSnapshot(session);
                }
            }

            for (const fallbackQuery of mode.fallbackQueries) {
                const textResult = await searchTextFallback(cityName, city.bounds, apiKey, fallbackQuery);

                textResult.places.forEach((place) => {
                    if (!place.place_id) {
                        return;
                    }
                    const existing = dedupedPlaces.get(place.place_id);
                    dedupedPlaces.set(place.place_id, existing ? mergePlaces(existing, place) : place);
                });

                completedOperations += textResult.requests;
                session.completed_operations = Math.min(estimate.maxRequests, completedOperations);
                session.request_count = completedOperations;
                session.total_results = dedupedPlaces.size;
                session.progress = {
                    phase: 'Text fallback search',
                    current: Math.min(estimate.maxRequests, completedOperations),
                    total: estimate.maxRequests,
                    percentage: Math.min(99, Math.round((completedOperations / estimate.maxRequests) * 100)),
                    currentLabel: `${cityName}: ${fallbackQuery.textQuery.replace('{{city}}', cityName)}`
                };
                session.updated_at = new Date().toISOString();

                await sleep(REQUEST_DELAY_MS);
            }

            completedCities += 1;
            session.progress = {
                phase: 'City complete',
                current: Math.min(estimate.maxRequests, completedOperations),
                total: estimate.maxRequests,
                percentage: Math.min(99, Math.round((completedOperations / estimate.maxRequests) * 100)),
                currentLabel: `${completedCities} of ${cityNames.length} cities complete`
            };
            session.updated_at = new Date().toISOString();
            await persistSessionSnapshot(session);
        }

        session.results = Array.from(dedupedPlaces.values());
        session.status = 'complete';
        session.completed_operations = estimate.maxRequests;
        session.request_count = completedOperations;
        session.total_results = session.results.length;
        session.progress = {
            phase: 'Complete',
            current: estimate.maxRequests,
            total: estimate.maxRequests,
            percentage: 100,
            currentLabel: `Found ${session.results.length} unique locations across ${cityNames.length} cities`
        };
        session.updated_at = new Date().toISOString();
        await persistSessionSnapshot(session, true);
    } catch (error) {
        session.status = 'failed';
        session.error_message = getGoogleErrorMessage(error);
        session.updated_at = new Date().toISOString();
        await persistSessionSnapshot(session);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'fitness-centers.html'));
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        tool: 'fitness-centers-scraper',
        supabaseConnected: !!supabase,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/cities', (req, res) => {
    res.json({
        cities: INDIAN_CITIES,
        defaults: {
            gridSpacingKm: GRID_SPACING_KM,
            searchRadiusMeters: SEARCH_RADIUS_METERS,
            maxNearbySubdivisions: MAX_NEARBY_SUBDIVISIONS,
            denseRecallKeywordCount: POINT_KEYWORD_QUERIES.length,
            fallbackPageLimit: TEXT_SEARCH_PAGE_LIMIT
        }
    });
});

app.get('/api/coverage-modes', (req, res) => {
    res.json({
        coverageModes: Object.values(COVERAGE_MODES).map((mode) => ({
            key: mode.key,
            label: mode.label,
            description: mode.description,
            includedTypes: mode.includedTypes,
            searchNearbyTypes: mode.searchNearbyTypes || mode.includedTypes,
            fallbackQueryCount: mode.fallbackQueries.length
        }))
    });
});

app.post('/api/validate-key', async (req, res) => {
    const { apiKey } = req.body;

    if (!apiKey) {
        return res.status(400).json({ valid: false, error: 'API key is required' });
    }

    try {
        await runGoogleRequest(() => axios.post(
            'https://places.googleapis.com/v1/places:searchNearby',
            {
                includedTypes: ['gym'],
                maxResultCount: 1,
                locationRestriction: {
                    circle: {
                        center: {
                            latitude: 28.6139,
                            longitude: 77.2090
                        },
                        radius: 500
                    }
                }
            },
            {
                headers: buildHeaders(apiKey),
                timeout: 15000
            }
        ));

        return res.json({ valid: true });
    } catch (error) {
        return res.status(400).json({
            valid: false,
            error: getGoogleErrorMessage(error)
        });
    }
});

app.post('/api/scrape', async (req, res) => {
    const { cityNames, cityName, modeKey, apiKey } = req.body;
    const normalizedCityNames = Array.isArray(cityNames)
        ? cityNames.filter((name, index, arr) => name && arr.indexOf(name) === index)
        : cityName ? [cityName] : [];

    if (!normalizedCityNames.length || normalizedCityNames.some((name) => !INDIAN_CITIES[name])) {
        return res.status(400).json({ error: 'At least one valid city is required' });
    }

    if (!apiKey) {
        return res.status(400).json({ error: 'API key is required' });
    }

    const sessionId = Date.now().toString();
    const estimate = estimateCombinedRequests(normalizedCityNames, modeKey);
    const mode = getCoverageMode(modeKey);

    sessions.set(sessionId, {
        session_id: sessionId,
        city_names: normalizedCityNames,
        mode_key: mode.key,
        mode_label: mode.label,
        status: 'starting',
        progress: {
            phase: 'Preparing',
            current: 0,
            total: estimate.maxRequests,
            percentage: 0,
            currentLabel: 'Building city search plan'
        },
        total_operations: estimate.maxRequests,
        completed_operations: 0,
        request_count: 0,
        total_results: 0,
        results: [],
        error_message: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    });

    await persistSessionSnapshot(sessions.get(sessionId));

    runScrapeInBackground(sessionId, normalizedCityNames, mode.key, apiKey)
        .catch((error) => {
            const session = sessions.get(sessionId);
            if (session) {
                session.status = 'failed';
                session.error_message = getGoogleErrorMessage(error);
                session.updated_at = new Date().toISOString();
                persistSessionSnapshot(session);
            }
        });

    return res.json({
        success: true,
        sessionId,
        estimate,
        cityNames: normalizedCityNames,
        mode: {
            key: mode.key,
            label: mode.label
        }
    });
});

app.get('/api/status/:sessionId', async (req, res) => {
    const session = await loadSession(req.params.sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({
        sessionId: session.session_id,
        cityNames: session.city_names,
        modeLabel: session.mode_label,
        modeKey: session.mode_key,
        status: session.status,
        progress: session.progress,
        requestCount: session.request_count,
        totalResults: session.total_results,
        error: session.error_message,
        updatedAt: session.updated_at
    });
});

app.get('/api/results/:sessionId', async (req, res) => {
    const session = await loadSession(req.params.sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({
        session: {
            sessionId: session.session_id,
            cityNames: session.city_names,
            modeKey: session.mode_key,
            modeLabel: session.mode_label,
            requestCount: session.request_count,
            totalResults: session.total_results,
            status: session.status
        },
        results: session.results
    });
});

app.listen(PORT, () => {
    console.log(`🏋️ Fitness Centers Scraper running on port ${PORT}`);
    console.log(`📍 Cities loaded: ${Object.keys(INDIAN_CITIES).length}`);
});
