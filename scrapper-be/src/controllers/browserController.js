const browserService = require("../services/browserService");

exports.startBrowser = async (req, res) => {

  try {

    const { url } = req.body;

    await browserService.startBrowser(url);

    res.json({
      success: true,
      message: "Browser started with CDP"
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

};