export default {
    SYSTEM_ERROR: [-1000, '系统异常'],
    SYSTEM_REQUEST_VALIDATION_ERROR: [-1001, '请求参数校验错误'],
    SYSTEM_NOT_ROUTE_MATCHING: [-1002, '无匹配的路由'],
    SYSTEM_API_KEY_INVALID: [-1003, 'API Key 无效或缺失']
} as Record<string, [number, string]>