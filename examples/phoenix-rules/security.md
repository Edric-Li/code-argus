# Phoenix 安全审查补充规范

> 项目特定的安全审查规则。

## 关键文件

以下文件变更需要特别关注安全性：

- `SecurityConfig.java` - Spring Security 配置
- `JwtAuthenticationFilter.java` - JWT 过滤器
- `*Request.java` - 请求 DTO（检查验证注解）
- `*Mapper.java` - MyBatis Mapper（检查 SQL 注入风险）
