require('insert-css')(require('./style.css'))

module.exports = {
    tagName: 'component-panel',
    className: 'component-panel',
    template: require('./template.html'),
    data: {
        headerText: 'Header Info',
        bodyContent: ''
    },
    created: function() {
      console.log(this.$compiler.rawContent.innerHTML);
      this.bodyContent = this.$compiler.rawContent.innerHTML;
    }
}