async function login(req, res, pool, clean, canonicalSucursal, publicUser, bcrypt) {
  try {
    const username = clean(req.body.username).toLowerCase();
    const password = String(req.body.password || '');
    const sucursalLogin = canonicalSucursal(
      req.body.sucursal || req.body.loginSucursal || ''
    );

    if (!username || !password) {
      return res.status(400).json({
        error: 'Usuario y contraseña son obligatorios.'
      });
    }

    const r = await pool.query(
      "select * from users where lower(username)=lower($1) limit 1",
      [username]
    );

    if (!r.rows.length) {
      return res.status(401).json({
        error: 'Usuario o contraseña incorrectos.'
      });
    }

    const user = r.rows[0];

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({
        error: 'Usuario o contraseña incorrectos.'
      });
    }

    req.session.user = publicUser(user);

    return res.json({
      ok: true,
      user: req.session.user
    });

  } catch (err) {
    console.error('LOGIN ERROR:', err);

    return res.status(500).json({
      error: 'Error interno de servidor'
    });
  }
}

module.exports = {
  login
};