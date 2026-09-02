<?php
declare(strict_types=1);

$STORE = getenv('BUGREPORT_DIR') ?: (__DIR__ . '/../../bugreports');
$MAX_BODY = 64 * 1024;
$MAX_DAY_PER_IP = 20;

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > $MAX_BODY) {
    http_response_code(413);
    echo json_encode(['error' => 'payload too large']);
    exit;
}

$data = json_decode($raw, true);
if (!is_array($data) || ($data['app'] ?? '') !== 'uartix-plus') {
    http_response_code(400);
    echo json_encode(['error' => 'bad payload']);
    exit;
}

$report = (string)($data['report'] ?? '');
if (strlen($report) < 10) {
    http_response_code(400);
    echo json_encode(['error' => 'report too short']);
    exit;
}

if (!is_dir($STORE) && !mkdir($STORE, 0750, true)) {
    http_response_code(500);
    echo json_encode(['error' => 'store unavailable']);
    exit;
}

$ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
$today = gmdate('Y-m-d');
$counterFile = $STORE . '/.rate-' . hash('sha256', $ip) . '-' . $today;
$count = 0;
if (is_file($counterFile)) {
    $count = (int)file_get_contents($counterFile);
}
if ($count >= $MAX_DAY_PER_IP) {
    http_response_code(429);
    echo json_encode(['error' => 'rate limited']);
    exit;
}
file_put_contents($counterFile, (string)($count + 1));

$record = [
    'ts' => gmdate('c'),
    'app' => 'uartix-plus',
    'version' => substr((string)($data['version'] ?? ''), 0, 32),
    'ip_hash' => substr(hash('sha256', $ip . gmdate('Y-m-d')), 0, 16),
    'report' => $report,
];

$file = $STORE . '/bug-' . gmdate('Ymd') . '.jsonl';
if (file_put_contents($file, json_encode($record, JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX) === false) {
    http_response_code(500);
    echo json_encode(['error' => 'write failed']);
    exit;
}

echo json_encode(['ok' => true]);
