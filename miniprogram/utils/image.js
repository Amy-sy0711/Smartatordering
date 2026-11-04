/** 选择本地图片并上传到云存储，返回 fileID */
function chooseAndUpload(folder) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success(res) {
        const file = (res.tempFiles || [])[0]
        if (!file || !file.tempFilePath) {
          reject(new Error('未选择图片'))
          return
        }
        const match = String(file.tempFilePath).match(/\.([a-zA-Z0-9]+)$/)
        const ext = match ? match[1] : 'jpg'
        const cloudPath = String(folder || 'images') + '/' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext
        wx.cloud
          .uploadFile({ cloudPath, filePath: file.tempFilePath })
          .then((res2) => resolve(res2.fileID))
          .catch((err) => reject(new Error((err && (err.errMsg || err.message)) || '上传失败')))
      },
      fail(err) {
        reject(new Error((err && (err.errMsg || err.message)) || '选择图片失败'))
      }
    })
  })
}

module.exports = { chooseAndUpload }
