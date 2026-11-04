"""Offline classification of well-known SDK/service domains. Heuristic.

A curated suffix list inspired by the domain-analysis approach of mature
scanners (e.g. MobSF), but fully offline: no network lookups, no reputation
claims. Matching a domain suggests an SDK is referenced, not that it is
active, nor that the app is malicious or safe.
"""

# suffix -> (sdk, category)
KNOWN_DOMAINS = {
    'firebaseio.com': ('Firebase Realtime Database', 'Backend / BaaS'),
    'firebase.google.com': ('Firebase', 'Backend / BaaS'),
    'firebaselogging.googleapis.com': ('Firebase Logging', 'Analíticas'),
    'app-measurement.com': ('Firebase Analytics', 'Analíticas'),
    'google-analytics.com': ('Google Analytics', 'Analíticas'),
    'analytics.google.com': ('Google Analytics', 'Analíticas'),
    'crashlytics.com': ('Crashlytics', 'Reporte de fallos'),
    'firebase-settings.crashlytics.com': ('Crashlytics', 'Reporte de fallos'),
    'bugsnag.com': ('Bugsnag', 'Reporte de fallos'),
    'sentry.io': ('Sentry', 'Reporte de fallos'),
    'doubleclick.net': ('Google Ads / DoubleClick', 'Publicidad'),
    'googlesyndication.com': ('Google AdSense', 'Publicidad'),
    'googleadservices.com': ('Google Ads', 'Publicidad'),
    'admob.com': ('AdMob', 'Publicidad'),
    'applovin.com': ('AppLovin', 'Publicidad'),
    'applvn.com': ('AppLovin', 'Publicidad'),
    'unityads.unity3d.com': ('Unity Ads', 'Publicidad'),
    'unity3d.com': ('Unity', 'Motor / SDK'),
    'mopub.com': ('MoPub', 'Publicidad'),
    'chartboost.com': ('Chartboost', 'Publicidad'),
    'vungle.com': ('Vungle', 'Publicidad'),
    'ironsrc.com': ('ironSource', 'Publicidad'),
    'tapjoy.com': ('Tapjoy', 'Publicidad'),
    'amazon-adsystem.com': ('Amazon Ads', 'Publicidad'),
    'flurry.com': ('Flurry', 'Analíticas'),
    'appsflyer.com': ('AppsFlyer', 'Atribución'),
    'adjust.com': ('Adjust', 'Atribución'),
    'branch.io': ('Branch', 'Atribución'),
    'amplitude.com': ('Amplitude', 'Analíticas'),
    'mixpanel.com': ('Mixpanel', 'Analíticas'),
    'segment.io': ('Segment', 'Analíticas'),
    'segment.com': ('Segment', 'Analíticas'),
    'onesignal.com': ('OneSignal', 'Notificaciones push'),
    'pushwoosh.com': ('Pushwoosh', 'Notificaciones push'),
    'airship.com': ('Airship', 'Notificaciones push'),
    'facebook.com': ('Facebook / Meta', 'Red social'),
    'graph.facebook.com': ('Facebook Graph API', 'Red social'),
    'fbcdn.net': ('Facebook CDN', 'Red social'),
    'instagram.com': ('Instagram / Meta', 'Red social'),
    'twitter.com': ('Twitter / X', 'Red social'),
    'x.com': ('Twitter / X', 'Red social'),
    'googleapis.com': ('Google APIs', 'Servicios Google'),
    'google.com': ('Google', 'Servicios Google'),
    'gstatic.com': ('Google Static', 'Servicios Google'),
    'googleusercontent.com': ('Google User Content', 'Servicios Google'),
    'cloudfront.net': ('Amazon CloudFront', 'CDN'),
    'akamaihd.net': ('Akamai', 'CDN'),
    'fastly.net': ('Fastly', 'CDN'),
    'cloudflare.com': ('Cloudflare', 'CDN'),
    'amazonaws.com': ('Amazon Web Services', 'Nube'),
    'azure.com': ('Microsoft Azure', 'Nube'),
    'windows.net': ('Microsoft Azure', 'Nube'),
    'stremio.com': ('Stremio', 'Streaming'),
    'strem.io': ('Stremio', 'Streaming'),
}


# Most specific (longest) suffix first so graph.facebook.com wins over facebook.com.
_SORTED_DOMAINS = sorted(KNOWN_DOMAINS.items(), key=lambda kv: -len(kv[0]))


def classify(host):
    """Return {'sdk', 'category'} for a known domain suffix, else None."""
    host = (host or '').lower().rstrip('.')
    if not host:
        return None
    for suffix, (sdk, category) in _SORTED_DOMAINS:
        if host == suffix or host.endswith('.' + suffix):
            return {'sdk': sdk, 'category': category}
    return None
