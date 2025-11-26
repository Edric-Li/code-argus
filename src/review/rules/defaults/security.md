# 安全审查规范

> security-reviewer 专用通用规则。

## 必须检查

### 1. 注入攻击

- **SQL 注入**: 字符串拼接 SQL，未使用参数化查询
- **命令注入**: 用户输入直接传入 shell 命令
- **XSS**: 未消毒的用户输入渲染到 HTML（`dangerouslySetInnerHTML`、`innerHTML`）
- **路径遍历**: 用户输入直接用于文件路径（`../` 攻击）
- **模板注入**: 用户输入直接嵌入模板引擎

### 2. 认证授权

- JWT Token 是否有过期时间
- Refresh Token 是否用 HttpOnly Cookie
- 登出时 Token 是否失效
- 密码是否用安全算法加密（BCrypt/Argon2）
- 敏感接口是否有权限校验

### 3. 输入验证

- 请求参数是否有验证（类型、长度、格式）
- 用户输入是否做了白名单/黑名单验证
- 文件上传是否验证类型和大小

### 4. 敏感数据

- API 响应是否过滤了密码等敏感字段
- 日志是否打印了敏感信息
- 错误信息是否暴露了系统细节

## 常见漏洞模式

```javascript
// ❌ SQL 注入
const query = `SELECT * FROM users WHERE id = '${userId}'`;

// ❌ 命令注入
exec(`ls ${userInput}`);

// ❌ XSS
element.innerHTML = userInput;
<div dangerouslySetInnerHTML={{ __html: userInput }} />;

// ❌ 路径遍历
const file = fs.readFileSync(path.join(baseDir, userInput));

// ❌ 敏感信息泄露
console.log(`Password: ${password}`);
return res.json(user); // user 包含 password 字段
```

```java
// ❌ SQL 注入 (MyBatis)
@Select("SELECT * FROM users WHERE name = '${name}'")

// ❌ 日志泄露
log.info("User password: {}", password);
```

## 严重程度指南

- **critical**: 可直接利用的漏洞（注入、认证绕过、数据泄露）
- **error**: 需要一定条件才能利用的安全弱点
- **warning**: 缺少最佳实践，存在潜在风险
- **suggestion**: 纵深防御建议
